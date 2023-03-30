
import * as child_process from "child_process";
import * as assert from "assert";

import { IModelImporter, IModelImportOptions } from "./IModelImporter";
import { BriefcaseDb, IModelDb, StandaloneDb } from "@itwin/core-backend";
import { Id64String, IDisposable } from "@itwin/core-bentley";

export interface MultiProcessImporterOptions extends IModelImportOptions {
  // TODO: implement
  /** the path to a module with a default export of an IModelImporter class to load */
  importerClassModulePath?: string;
  hackImportMultiAspectCbScope: {
    targetScopeElementId: Id64String;
    optionsIncludeSourceProvenance: boolean;
  };
}

/** @internal */
const forwardedMethods = [
  "importModel",
  "importElement",
  "importRelationship",
  "importElementMultiAspects",
  "importElementUniqueAspect",
  "deleteElement",
  "deleteModel",
  "optimizeGeometry",
  "computeProjectExtents",
] as const;

/** @internal */
export type ForwardedMethods = (typeof forwardedMethods)[number];

/** @internal */
export enum Messages {
  Init,
  SetOption,
  CallMethod,
  Finalize,

  Await,
  Settled,
}

/** @internal */
export type Message =
  | {
      type: Messages.Init;
      importerInitOptions: MultiProcessImporterOptions;
    }
  | {
      type: Messages.SetOption;
      key: keyof IModelImporter["options"];
      value: any;
    }
  | {
      type: Messages.CallMethod;
      target: string;
      method: string;
      args: any;
    }
  | {
      type: Messages.Finalize;
    }
  | {
      type: Messages.Await;
      id: number;
      message: Message;
    }
  | {
      type: Messages.Settled;
      result: any;
      id: number;
    }
  ;

// TODO: promise the results for each individual call, atm not necessary
/** wrap a function with backoff upon a condition */
function backoff<F extends (...a: any[]) => any>(
  action: F,
  {
    checkResultForBackoff = (r: ReturnType<F>) => !!r,
    dontRetryLastBackoff = false,
    waitMs = 200,
  } = {}
) {
  const callQueue: Parameters<F>[] = [];
  let drainQueueTimeout: NodeJS.Timer | undefined;

  const tryDrainQueue = () => {
    drainQueueTimeout = undefined;

    let callArgs: Parameters<F>;
    while (callArgs = callQueue[callQueue.length - 1]) {
      const result = action(...callArgs);
      const shouldBackoff = checkResultForBackoff(result);
      if (!shouldBackoff || dontRetryLastBackoff)
        callQueue.pop();
      if (shouldBackoff)
        break;
    }

    if (callQueue.length > 0) 
      drainQueueTimeout = setTimeout(tryDrainQueue, waitMs);
  };

  const backoffHandler = (...args: Parameters<F>) => {
    callQueue.unshift(args);
    if (!drainQueueTimeout)
      tryDrainQueue();
  };

  return tryDrainQueue;
}

export class MultiProcessIModelImporter extends IModelImporter implements IDisposable {
  private _worker: child_process.ChildProcess;

  private _nextId = 0;
  private _pendingResolvers = new Map<number, (v: any) => any>();

  private _backoffSignal = Promise.resolve();

  private _send(msg: Message, cb?: (err: null | Error) => void) {
    const whenReady = () => {
      const success = this._worker.send(msg, cb);
      if (success) return;
      // FIXME: apparently the last one to send is still sent so don't resend, just start backoff...
      // need a way to know exactly if it needs to be retried
      this._backoffSignal = new Promise(r => setTimeout(r, 200));
    };

    this._backoffSignal.then(whenReady);
  }

  private _promiseMessage(wrapperMsg: { type: Messages.Await, message: Message }): Promise<any> {
    const id = this._nextId;
    this._nextId++;

    let resolve!: (v: any) => void, reject: (v: any) => void;
    const promise = new Promise<any>((_res, _rej) => { resolve = _res; reject = _rej; });
    this._pendingResolvers.set(id, resolve);
    this._send({ ...wrapperMsg, id } as Message, (err: any) => err && reject(err));
    return promise;
  }

  public static async create(targetDb: IModelDb, options: MultiProcessImporterOptions): Promise<MultiProcessIModelImporter> {
    if (!targetDb.isReadonly) {
      const targetDbPath = targetDb.pathName;
      const targetDbType = targetDb.constructor as typeof BriefcaseDb | typeof StandaloneDb;
      targetDb.close(); // close it, the spawned process will need the write lock
      const readonlyTargetDb = await targetDbType.open({ fileName: targetDbPath, readonly: true });
      targetDb = readonlyTargetDb;

      // TODO use a library to do this
      for (const { target, key: targetKey, forwardedMethods, promisedMethods, set } of [
        { target: targetDb, key: "targetDb", promisedMethods: ["importSchemas", "saveChanges"], set: (v: any) => (targetDb = v) },
        { target: targetDb.elements, key: "targetDb.elements", forwardedMethods: ["insertAspect", "updateAspect", "updateElement"], set: (v: any) => ((targetDb as any).elements = v) },
        // TODO: does this really need to be a promised method?
        { target: targetDb.codeSpecs, key: "targetDb.codeSpecs", promisedMethods: ["insert"], set: (v: any) => ((targetDb as any)._codeSpecs = v) },
        { target: targetDb.relationships, key: "targetDb.relationships", forwardedMethods: ["insertRelationship"], set: (v: any) => ((targetDb as any)._relationships = v)  },
        { target: targetDb.models, key: "targetDb.relationships", forwardedMethods: ["insertModel", "updateModel"], set: (v: any) => ((targetDb as any).models = v)  },
      ] as const) {
        set(new Proxy(target, {
          get: (obj, key: string, recv) => {
            if ((forwardedMethods as readonly string[])?.includes(key)) {
              return (...args: any[]) => instance._send({
                type: Messages.CallMethod,
                target: targetKey,
                method: key,
                args,
              });
            } else if ((promisedMethods as readonly string[])?.includes(key)) {
              return (...args: any[]) => instance._promiseMessage({
                type: Messages.Await,
                message: {
                  type: Messages.CallMethod,
                  target: targetKey,
                  method: key,
                  args,
                },
              });
            } else
              return Reflect.get(obj, key, recv);
          }
        }));
      }
    }

    const instance = new MultiProcessIModelImporter(targetDb, options);
    return instance;
  }

  private constructor(targetDb: IModelDb, options: MultiProcessImporterOptions) {
    super(targetDb, options);

    this._worker = child_process.fork(require.resolve("./MultiProcessEntry"),
      // TODO: encode options? should be ok if we don't use shell
      [targetDb.pathName, JSON.stringify(options)],
      {
        stdio: "inherit",
        execArgv: [
          process.env.INSPECT_WORKER && `--inspect-brk=${process.env.INSPECT_WORKER}`,
        ].filter(Boolean) as string[],
        serialization: "advanced", // allow transferring of binary geometry efficiently
      }
    );

    const onMsg = (msg: Message) => {
      let resolver: ((v: any) => void) | undefined;
      if (msg.type === Messages.Settled && (resolver = this._pendingResolvers.get(msg.id))) {
        resolver(msg.result);
      }
    };

    this._worker.on("message", onMsg);

    (this as { options: IModelImportOptions }).options = new Proxy(this.options, {
      set: (obj, key, val, recv) => {
        this._send({
          type: Messages.SetOption,
          key: key,
          value: val,
        } as Message);
        if (process.env.DEBUG?.includes("multiproc")) console.log("parent set option:", JSON.stringify({ key, val }));
        return Reflect.set(obj, key, val, recv);
      }
    });

    for (const key of forwardedMethods) {
      Object.defineProperty(this, key, {
        value: (...args: Parameters<IModelImporter[typeof key]>) => {
          if (process.env.DEBUG?.includes("multiproc")) console.log("parent forwarding:", JSON.stringify({ key, args }));
          const msg: Message = {
            type: Messages.CallMethod,
            target: "importer",
            method: key,
            args,
          };
          // TODO: make each message decide whether it needs to be awaited rather than this HACK (also inline them manually?)
          return key === "importElement" || key === "importElementUniqueAspect"
            ? this._promiseMessage({ type: Messages.Await, message: msg })
            : key === "importElementMultiAspects" // HACK: don't try to serialize the callback (second arg)
            ? this._promiseMessage({ type: Messages.Await, message: { ...msg, args: msg.args.slice(0, 1)} })
            : this._send(msg);
        },
        writable: false,
        enumerable: false,
        configurable: false,
      });
    }
  }

  public override dispose() {
    this._worker.kill();
  }
}

