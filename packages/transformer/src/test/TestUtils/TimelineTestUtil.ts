/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/

import { assert, expect } from "chai";
import {
  BriefcaseDb,
  IModelDb,
  IModelHost,
  PhysicalModel,
  PhysicalObject,
  PhysicalPartition,
  SpatialCategory,
} from "@itwin/core-backend";

import {
  ChangesetIdWithIndex,
  Code,
  ElementProps,
  IModel,
  PhysicalElementProps,
  RelationshipProps,
  SubCategoryAppearance,
} from "@itwin/core-common";
import { Point3d, YawPitchRollAngles } from "@itwin/core-geometry";
import {
  IModelTransformer,
  IModelTransformOptions,
} from "../../IModelTransformer";
import {
  HubWrappers,
  IModelTransformerTestUtils,
} from "../IModelTransformerUtils";
import { IModelTestUtils } from "./IModelTestUtils";
import { omit } from "@itwin/core-bentley";
import { ExportChangesOptions, IModelExporter } from "../../IModelExporter";

const saveAndPushChanges = async (
  accessToken: string,
  briefcase: BriefcaseDb,
  description: string
) => IModelTestUtils.saveAndPushChanges(accessToken, briefcase, description);

export const deleted = Symbol("DELETED");

// NOTE: this is not done optimally
export function getIModelState(db: IModelDb): TimelineIModelElemState {
  const result = {} as TimelineIModelElemState;

  const elemIds = db.withPreparedStatement(
    `
    SELECT ECInstanceId
    FROM Bis.Element
    WHERE ECInstanceId>${IModelDb.dictionaryId}
      -- ignore the known required elements set in 'populateTimelineSeed'
      AND CodeValue NOT IN ('SpatialCategory', 'PhysicalModel')
  `,
    (s) => [...s].map((row) => row.id)
  );

  for (const elemId of elemIds) {
    const elem = db.elements.getElement(elemId);
    const tag = elem.userLabel ?? elem.id;
    if (tag in result)
      throw Error("timelines only support iModels with unique user labels");
    const isSimplePhysicalObject =
      elem.jsonProperties.updateState !== undefined;

    result[tag] = isSimplePhysicalObject
      ? elem.jsonProperties.updateState
      : elem.toJSON();
  }

  const supportedRelIds = db.withPreparedStatement(
    `
    SELECT erte.ECInstanceId, erte.ECClassId,
        se.ECInstanceId AS SourceId, se.UserLabel AS SourceUserLabel,
        te.ECInstanceId AS TargetId, te.UserLabel AS TargetUserLabel
    FROM Bis.ElementRefersToElements erte
    JOIN Bis.Element se
      ON se.ECInstanceId=erte.SourceECInstanceId
    JOIN Bis.Element te
      ON te.ECInstanceId=erte.TargetECInstanceId
  `,
    (s) => [...s]
  );

  for (const {
    id,
    className,
    sourceId,
    sourceUserLabel,
    targetId,
    targetUserLabel,
  } of supportedRelIds) {
    const relProps = db.relationships.getInstanceProps(className, id);
    const tag = `REL_${sourceUserLabel ?? sourceId}_${
      targetUserLabel ?? targetId
    }_${className}`;
    if (tag in result)
      throw Error("timelines only support iModels with unique user labels");

    result[tag] = omit(relProps, ["id"]);
  }

  return result;
}

export function applyDelta(
  state: TimelineIModelElemState,
  patch: TimelineIModelElemStateDelta
): TimelineIModelElemState {
  const patched = { ...state, ...patch };

  for (const [key, value] of Object.entries(patched)) {
    if (value === deleted) delete patched[key];
  }

  return patched as TimelineIModelElemState;
}

export function populateTimelineSeed(
  db: IModelDb,
  state?: TimelineIModelElemStateDelta
): void {
  SpatialCategory.insert(
    db,
    IModel.dictionaryId,
    "SpatialCategory",
    new SubCategoryAppearance()
  );
  PhysicalModel.insert(db, IModel.rootSubjectId, "PhysicalModel");
  if (state) maintainObjects(db, state);
  db.performCheckpoint();
}

export function assertElemState(
  db: IModelDb,
  state: TimelineIModelElemStateDelta,
  { subset = false } = {}
): void {
  expect(getIModelState(db)).to.deep.subsetEqual(state, {
    useSubsetEquality: subset,
  });
}

function maintainObjects(
  iModelDb: IModelDb,
  delta: TimelineIModelElemStateDelta
): void {
  const modelId = iModelDb.elements.queryElementIdByCode(
    PhysicalPartition.createCode(
      iModelDb,
      IModel.rootSubjectId,
      "PhysicalModel"
    )
  )!;
  const categoryId = iModelDb.elements.queryElementIdByCode(
    SpatialCategory.createCode(iModelDb, IModel.dictionaryId, "SpatialCategory")
  )!;

  for (const [elemName, upsertVal] of Object.entries(delta)) {
    const isRel = (d: TimelineElemDelta): d is RelationshipProps =>
      (d as RelationshipProps).sourceId !== undefined;

    if (isRel(upsertVal))
      throw Error(
        "adding relationships to the small delta format is not supported" +
          "use a `manualUpdate` step instead"
      );

    const [id] = iModelDb.queryEntityIds({
      from: "Bis.Element",
      where: "UserLabel=?",
      bindings: [elemName],
    });

    if (upsertVal === deleted) {
      assert(id, "tried to delete an element that wasn't in the database");
      iModelDb.elements.deleteElement(id);
      continue;
    }

    const props: ElementProps | PhysicalElementProps =
      typeof upsertVal !== "number"
        ? upsertVal
        : {
            classFullName: PhysicalObject.classFullName,
            model: modelId,
            category: categoryId,
            code: new Code({
              spec: IModelDb.rootSubjectId,
              scope: IModelDb.rootSubjectId,
              value: elemName,
            }),
            userLabel: elemName,
            geom: IModelTransformerTestUtils.createBox(Point3d.create(1, 1, 1)),
            placement: {
              origin: Point3d.create(0, 0, 0),
              angles: YawPitchRollAngles.createDegrees(0, 0, 0),
            },
            jsonProperties: {
              updateState: upsertVal,
            },
          };

    props.id = id;

    if (id === undefined) iModelDb.elements.insertElement(props);
    else iModelDb.elements.updateElement(props);
  }

  // TODO: iModelDb.performCheckpoint?
  iModelDb.saveChanges();
}

export type TimelineElemState =
  | number
  | Omit<ElementProps, "userLabel">
  | RelationshipProps;
export type TimelineElemDelta = TimelineElemState | typeof deleted;

export interface TimelineIModelElemStateDelta {
  [name: string]: TimelineElemDelta;
}

/** [name: string]: Becomes the userlabel / codevalue of a physical object in the iModel.
 * Note that since JS converts all keys to strings, passing keys as numbers is also allowed. They will be converted to strings.
 * TimelineElemState if it is a number sets a json property on the physicalobject to the number provided.
 */
export interface TimelineIModelElemState {
  [name: string]: TimelineElemState;
}

export interface TimelineIModelState {
  state: TimelineIModelElemState;
  id: string;
  db: BriefcaseDb;
}

export type ManualUpdateFunc = (db: IModelDb) => void | Promise<void>;

export type TimelineStateChange =
  // update the state of that model to match and push a changeset
  | TimelineIModelElemStateDelta
  // create a new iModel from a seed
  | { seed: TimelineIModelState }
  // create a branch from an existing iModel with a given name
  | { branch: string }
  // synchronize with the changes in an iModel of a given name from a starting timeline point
  | {
      sync: [
        source: string,
        opts?: {
          since?: number;
          init?: {
            initTransformer?: (transformer: IModelTransformer) => void;
            afterInitializeExporter?: (
              exporter: IModelExporter
            ) => Promise<void>; // Run this code after exporter.initialize is called
          };
          expectThrow?: boolean;
          assert?: {
            afterProcessChanges?: (transformer: IModelTransformer) => void;
          };
        },
      ];
    }
  // manually update an iModel, state will be automatically detected after. Useful for more complicated
  // element changes with inter-dependencies.
  // @note: the key for the element in the state will be the userLabel or if none, the id
  | { manualUpdate: ManualUpdateFunc }
  // manually update an iModel, like `manualUpdate`, but close and reopen the db after. This is
  // if you're doing something weird like a raw sqlite update on the file.
  | { manualUpdateAndReopen: ManualUpdateFunc };

/** an object that helps resolve ids from names */
export type TimelineReferences = Record<string, ElementProps>;

/**
 * A small tree-sitter inspired DSL for building timelines of iModel updates and branching/forking events
 * The `$` can be used to refer to props that aren't resolved until later (e.g. the id of inserted elements)
 *
 * For each step in timeline, an object of iModels mapping to the event that occurs for them:
 * - a 'seed' event with an iModel to seed from, creating the iModel
 * - a 'branch' event with the name of an iModel to seed from, creating the iModel
 * - a 'sync' event with the name of an iModel and timeline point to sync from
 * - an object containing a mapping of user labels to elements to be upserted or to the `deleted` symbol
 *    for elements to be deleted. If the iModel doesn't exist, it is created.
 * - an 'assert' function to run on the state of all the iModels in the timeline
 *
 * @note because the timeline manages PhysicalObjects for the state, any seed must contain the necessary
 *       model and category, which can be added to your seed by calling @see populateTimelineSeed
 */
export type Timeline = Record<
  number,
  {
    assert?: (imodels: Record<string, TimelineIModelState>) => void;
    [modelName: string]:
      | undefined // only necessary for the previous optional properties
      | ((imodels: Record<string, TimelineIModelState>) => void) // only necessary for the assert property
      | TimelineStateChange;
  }
>;

export interface TestContextOpts {
  iTwinId: string;
  accessToken: string;
  transformerOpts?: IModelTransformOptions;
}

/**
 * Run the branching and synchronization events in a @see Timeline object
 * you can print additional debug info from this by setting in your env TRANSFORMER_BRANCH_TEST_DEBUG=1
 * @note expected state after synchronization is not asserted because element deletions and elements that are
 * updated only in the target are hard to track. You can assert it yourself with @see assertElemState in
 * an assert step for your timeline
 */
export async function runTimeline(
  timeline: Timeline,
  { iTwinId, accessToken, transformerOpts }: TestContextOpts
) {
  const trackedIModels = new Map<string, TimelineIModelState>();
  const masterOfBranch = new Map<string, string>();

  /* eslint-disable @typescript-eslint/indent */
  const timelineStates = new Map<
    number,
    {
      states: { [iModelName: string]: TimelineIModelElemStateDelta };
      changesets: { [iModelName: string]: ChangesetIdWithIndex };
    }
  >();
  /* eslint-enable @typescript-eslint/indent */

  function printChangelogs() {
    const rows = [...timelineStates.values()].map((state) =>
      Object.fromEntries(
        Object.entries(state.changesets)
          .map(([name, cs]) => [
            [name, `${cs.index} ${cs.id.slice(0, 5)}`],
            [
              `${name} state`,
              `${Object.keys(state.states[name]).map((k) => k.slice(0, 6))}`,
            ],
          ])
          .flat()
      )
    );
    // eslint-disable-next-line no-console
    console.table(rows);
  }

  const getSeed = (model: TimelineStateChange) =>
    (model as { seed: TimelineIModelState | undefined }).seed;
  const getBranch = (model: TimelineStateChange) =>
    (model as { branch: string | undefined }).branch;
  const getSync = (model: TimelineStateChange) =>
    // HACK: concat {} so destructuring works if opts were undefined
    (model as any).sync?.concat({}) as
      | [
          src: string,
          opts: {
            since?: number;
            init?: {
              afterInitializeExporter?: (
                exporter: IModelExporter
              ) => Promise<void>;
              initTransformer?: (transformer: IModelTransformer) => void;
            };
            expectThrow?: boolean;
            assert?: {
              afterProcessChanges?: (transformer: IModelTransformer) => void;
            };
          },
        ]
      | undefined;
  const getManualUpdate = (
    model: TimelineStateChange
  ): { update: ManualUpdateFunc; doReopen: boolean } | undefined =>
    (model as any).manualUpdate || (model as any).manualUpdateAndReopen
      ? {
          update:
            (model as any).manualUpdate ?? (model as any).manualUpdateAndReopen,
          doReopen: !!(model as any).manualUpdateAndReopen,
        }
      : undefined;

  for (let i = 0; i < Object.values(timeline).length; ++i) {
    const pt = timeline[i];
    if (process.env.TRANSFORMER_BRANCH_TEST_DEBUG)
      console.log(`pt[${i}] -> ${JSON.stringify(pt)}`); // eslint-disable-line no-console

    const iModelChanges = Object.entries(pt).filter(
      (entry): entry is [string, TimelineStateChange] =>
        entry[0] !== "assert" && trackedIModels.has(entry[0])
    );

    const newIModels = Object.keys(pt).filter(
      (s) => s !== "assert" && !trackedIModels.has(s)
    );

    for (const newIModelName of newIModels) {
      assert(
        newIModelName !== "assert",
        "should have already been filtered out"
      );

      const newIModelEvent = pt[newIModelName];
      assert(typeof newIModelEvent === "object");
      assert(
        !("sync" in newIModelEvent),
        "cannot sync an iModel that hasn't been created yet!"
      );
      assert(
        !Object.values(newIModelEvent).includes(deleted),
        "cannot delete elements in an iModel that you are creating now!"
      );

      const seed =
        (getSeed(newIModelEvent) ??
          (getBranch(newIModelEvent) &&
            trackedIModels.get(getBranch(newIModelEvent)!))) ||
        undefined;

      seed?.db.performCheckpoint(); // make sure WAL is flushed before we use this as a file seed
      const newIModelId = await IModelHost.hubAccess.createNewIModel({
        iTwinId,
        iModelName: newIModelName,
        version0: seed?.db.pathName,
        noLocks: true,
      });

      const newIModelDb = await HubWrappers.downloadAndOpenBriefcase({
        accessToken,
        iTwinId,
        iModelId: newIModelId,
      });
      assert.isTrue(newIModelDb.isBriefcaseDb());
      assert.equal(newIModelDb.iTwinId, iTwinId);

      const newTrackedIModel = {
        state: seed?.state ?? (newIModelEvent as TimelineIModelElemState),
        db: newIModelDb,
        id: newIModelId,
      };

      trackedIModels.set(newIModelName, newTrackedIModel);

      const isNewBranch = "branch" in newIModelEvent;
      if (isNewBranch) {
        assert(seed);
        masterOfBranch.set(newIModelName, newIModelEvent.branch as string);
        const master = seed;
        const branchDb = newIModelDb;
        // record branch provenance
        const provenanceInserter = new IModelTransformer(master.db, branchDb, {
          ...transformerOpts,
          wasSourceIModelCopiedToTarget: true,
        });
        await provenanceInserter.process();
        provenanceInserter.dispose();
        await saveAndPushChanges(
          accessToken,
          branchDb,
          "initialized branch provenance"
        );
      } else if ("seed" in newIModelEvent) {
        await saveAndPushChanges(
          accessToken,
          newIModelDb,
          `seeded from '${getSeed(newIModelEvent)!.id}' at point ${i}`
        );
      } else {
        populateTimelineSeed(newIModelDb);
        const maybeManualUpdate = getManualUpdate(newIModelEvent);
        if (maybeManualUpdate) {
          await maybeManualUpdate.update(newIModelDb);
          if (maybeManualUpdate.doReopen) {
            const fileName = newTrackedIModel.db.pathName;
            newTrackedIModel.db.close();
            newTrackedIModel.db = await BriefcaseDb.open({ fileName });
          }
          newTrackedIModel.state = getIModelState(newIModelDb);
        } else
          maintainObjects(
            newIModelDb,
            newIModelEvent as TimelineIModelElemStateDelta
          );
        await saveAndPushChanges(
          accessToken,
          newIModelDb,
          `new with state [${JSON.stringify(newIModelEvent)}] at point ${i}`
        );
      }

      if (seed) {
        assertElemState(newIModelDb, seed.state);
      }
    }

    for (const [iModelName, event] of iModelChanges) {
      if ("branch" in event || "seed" in event) {
        // "branch" and "seed" event has already been handled in the new imodels loop above
        continue;
      } else if ("sync" in event) {
        const [
          syncSource,
          {
            since: startIndex,
            init: initFxns,
            expectThrow,
            assert: assertFxns,
          },
        ] = getSync(event)!;
        // if the synchronization source is master, it's a normal sync
        const isForwardSync = masterOfBranch.get(iModelName) === syncSource;
        const target = trackedIModels.get(iModelName)!;
        const source = trackedIModels.get(syncSource)!;

        let targetStateBefore: TimelineIModelElemState | undefined;
        if (process.env.TRANSFORMER_BRANCH_TEST_DEBUG)
          targetStateBefore = getIModelState(target.db);
        let argsForProcessChanges: ExportChangesOptions = { csFileProps: [] };
        if (startIndex) {
          argsForProcessChanges = { startChangeset: { index: startIndex } };
        }
        const syncer = new IModelTransformer(source.db, target.db, {
          ...transformerOpts,
          argsForProcessChanges,
        });

        if (initFxns?.afterInitializeExporter) {
          await syncer.exporter.initialize(argsForProcessChanges);
          await initFxns?.afterInitializeExporter?.(syncer.exporter);
        }

        initFxns?.initTransformer?.(syncer);
        try {
          await syncer.process();
          expect(
            expectThrow === false || expectThrow === undefined,
            "expectThrow was set to true and transformer succeeded."
          ).to.be.true;
          assertFxns?.afterProcessChanges?.(syncer);
        } catch (err: any) {
          if (/startChangesetId should be exactly/.test(err.message)) {
            console.log("change history:"); // eslint-disable-line
            printChangelogs();
          }
          if (
            !expectThrow ||
            (expectThrow &&
              err.message.includes(
                "expectThrow was set to true and transformer succeeded."
              ))
          )
            throw err;
        } finally {
          syncer.dispose();
        }

        const stateMsg = `synced changes from ${syncSource} to ${iModelName} at ${i}`;
        if (process.env.TRANSFORMER_BRANCH_TEST_DEBUG) {
          /* eslint-disable no-console */
          console.log(stateMsg);
          console.log(`       source state: ${JSON.stringify(source.state)}`);
          const targetState = getIModelState(target.db);
          console.log(
            `target before state: ${JSON.stringify(targetStateBefore!)}`
          );
          console.log(` target after state: ${JSON.stringify(targetState)}`);
          /* eslint-enable no-console */
        }

        target.state = getIModelState(target.db); // update the tracking state

        if (!expectThrow) {
          if (!isForwardSync)
            await saveAndPushChanges(accessToken, source.db, stateMsg);
          await saveAndPushChanges(accessToken, target.db, stateMsg);
        }
      } else {
        const alreadySeenIModel = trackedIModels.get(iModelName)!;
        let stateMsg: string;

        if ("manualUpdate" in event || "manualUpdateAndReopen" in event) {
          const manualUpdate = getManualUpdate(event)!;
          await manualUpdate.update(alreadySeenIModel.db);
          if (manualUpdate.doReopen) {
            const fileName = alreadySeenIModel.db.pathName;
            alreadySeenIModel.db.close();
            alreadySeenIModel.db = await BriefcaseDb.open({ fileName });
          }
          alreadySeenIModel.state = getIModelState(alreadySeenIModel.db);
          stateMsg =
            `${iModelName} becomes: ${JSON.stringify(
              alreadySeenIModel.state
            )}, ` + `after manual update, at ${i}`;
        } else {
          const delta = event;
          alreadySeenIModel.state = applyDelta(alreadySeenIModel.state, delta);
          maintainObjects(alreadySeenIModel.db, delta);
          stateMsg =
            `${iModelName} becomes: ${JSON.stringify(
              alreadySeenIModel.state
            )}, ` + `delta: [${JSON.stringify(delta)}], at ${i}`;
        }

        if (process.env.TRANSFORMER_BRANCH_TEST_DEBUG) console.log(stateMsg); // eslint-disable-line no-console

        await saveAndPushChanges(accessToken, alreadySeenIModel.db, stateMsg);
      }
    }

    if (pt.assert) {
      pt.assert(Object.fromEntries(trackedIModels));
    }

    timelineStates.set(i, {
      changesets: Object.fromEntries(
        [...trackedIModels].map(([name, state]) => [name, state.db.changeset])
      ),
      states: Object.fromEntries(
        [...trackedIModels].map(([name, state]) => [name, state.state])
      ),
    });
  }

  return {
    trackedIModels,
    timelineStates,
    tearDown: async () => {
      for (const [, state] of trackedIModels) {
        state.db.close();
        await IModelHost.hubAccess.deleteIModel({
          iTwinId,
          iModelId: state.id,
        });
      }
    },
    printChangelogs,
  };
}
