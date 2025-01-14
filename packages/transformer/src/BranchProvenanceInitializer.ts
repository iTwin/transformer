/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/
import {
  BriefcaseDb,
  ExternalSource,
  ExternalSourceIsInRepository,
  IModelDb,
  RepositoryLink,
  StandaloneDb,
} from "@itwin/core-backend";
import { DbResult, Id64String, Logger, OpenMode } from "@itwin/core-bentley";
import {
  Code,
  ExternalSourceProps,
  RepositoryLinkProps,
} from "@itwin/core-common";
import * as assert from "assert";
import { IModelTransformer } from "./IModelTransformer";
import { pathToFileURL } from "url";
/**
 * @alpha
 */
export interface ProvenanceInitArgs {
  /** the master iModel which is the source of the provenance */
  master: IModelDb;
  /** the canonical url of the master iModel */
  masterUrl?: string;
  /** the description of the master iModel */
  masterDescription?: string;
  /**
   * @param {IModelDb} branchDb - the branch iModel which is the container of the provenance
   *                              Must be opened Read/Write
   */
  branch: IModelDb;
  /**
   * insert Federation Guids in all lacking elements in the master database, which will prevent
   * needing to insert External Source Aspects for provenance tracking
   * @note requires a read/write master
   * @note closes both the master and branch iModels to reset caches, so you must reopen them.
   *       If you pass `"keep-reopened-db"`, this object's `master` and `branch` properties will
   *       be set to new, open databases.
   */
  createFedGuidsForMaster?: true | false | "keep-reopened-db";
}

/**
 * @alpha
 */
export interface ProvenanceInitResult {
  targetScopeElementId: Id64String;
  masterExternalSourceId: Id64String;
  masterRepositoryLinkId: Id64String;
}

/**
 * @alpha
 */
export async function initializeBranchProvenance(
  args: ProvenanceInitArgs
): Promise<ProvenanceInitResult> {
  if (args.createFedGuidsForMaster) {
    // FIXME<LOW>: Consider enforcing that the master and branch dbs passed as part of ProvenanceInitArgs to this function
    // are identical. https://github.com/iTwin/imodel-transformer/issues/138
    /* eslint-disable deprecation/deprecation */
    args.master.withSqliteStatement(
      `
        UPDATE bis_Element
        SET FederationGuid=randomblob(16)
        WHERE FederationGuid IS NULL
      `,
      // eslint-disable-next-line @itwin/no-internal
      (s) =>
        assert(
          s.step() === DbResult.BE_SQLITE_DONE,
          args.branch.getLastError()
        )
    );
    const masterPath = args.master.pathName;
    const reopenMaster = makeDbReopener(args.master);
    args.master.close(); // prevent busy
    args.branch.withSqliteStatement(
      `ATTACH DATABASE '${pathToFileURL(`${masterPath}`)}?mode=ro' AS master`,
      // eslint-disable-next-line @itwin/no-internal
      (s) =>
        assert(
          s.step() === DbResult.BE_SQLITE_DONE,
          args.branch.getLastError()
        )
    );
    args.branch.withSqliteStatement(
      `
      UPDATE main.bis_Element
      SET FederationGuid = (
        SELECT m.FederationGuid
        FROM master.bis_Element m
        WHERE m.Id=main.bis_Element.Id
      )`,

      // eslint-disable-next-line @itwin/no-internal
      (s) =>
        assert(
          s.step() === DbResult.BE_SQLITE_DONE,
          args.branch.getLastError()
        )
    );
    args.branch.clearCaches(); // statements write lock attached db (clearing statement cache does not fix this)
    args.branch.saveChanges();
    args.branch.withSqliteStatement("DETACH DATABASE master", (s) => {
      const res = s.step();
      if (res !== DbResult.BE_SQLITE_DONE)
        Logger.logTrace(
          "initializeBranchProvenance",
          `Error detaching db (we will close anyway): ${args.branch.getLastError()}`
        );
      // this is the case until native side changes
      // eslint-disable-next-line @itwin/no-internal
      assert(
        res === DbResult.BE_SQLITE_ERROR,
        args.branch.getLastError()
      );
    });
    /* eslint-enable deprecation/deprecation */
    args.branch.performCheckpoint();

    const reopenBranch = makeDbReopener(args.branch);
    // close dbs because element cache could be invalid
    args.branch.close();
    [args.master, args.branch] = await Promise.all([
      reopenMaster(),
      reopenBranch(),
    ]);
  }

  // create an external source and owning repository link to use as our *Target Scope Element* for future synchronizations
  const masterRepoLinkId = args.branch.elements.insertElement({
    classFullName: RepositoryLink.classFullName,
    code: RepositoryLink.createCode(
      args.branch,
      IModelDb.repositoryModelId,
      "example-code-value"
    ),
    model: IModelDb.repositoryModelId,
    url: args.masterUrl,
    format: "iModel",
    repositoryGuid: args.master.iModelId,
    description: args.masterDescription,
  } as RepositoryLinkProps);

  const masterExternalSourceId = args.branch.elements.insertElement({
    classFullName: ExternalSource.classFullName,
    model: IModelDb.rootSubjectId,
    code: Code.createEmpty(),
    repository: new ExternalSourceIsInRepository(masterRepoLinkId),
    /* eslint-disable @typescript-eslint/no-var-requires */
    connectorName: require("../../package.json").name,
    connectorVersion: require("../../package.json").version,
    /* eslint-enable @typescript-eslint/no-var-requires */
  } as ExternalSourceProps);

  const fedGuidLessElemsSql = `
    SELECT ECInstanceId AS id
    FROM Bis.Element
    WHERE FederationGuid IS NULL
      AND ECInstanceId NOT IN (0x1, 0xe, 0x10) /* ignore special elems */
  `;
  const elemReader = args.branch.createQueryReader(
    fedGuidLessElemsSql,
    undefined,
    { usePrimaryConn: true }
  );
  while (await elemReader.step()) {
    const id: string = elemReader.current.toRow().id;
    const aspectProps = IModelTransformer.initElementProvenanceOptions(id, id, {
      isReverseSynchronization: false,
      targetScopeElementId: masterExternalSourceId,
      sourceDb: args.master,
      targetDb: args.branch,
    });
    args.branch.elements.insertAspect(aspectProps);
  }

  const fedGuidLessRelsSql = `
    SELECT erte.ECInstanceId as id
    FROM Bis.ElementRefersToElements erte
    JOIN bis.Element se
      ON se.ECInstanceId=erte.SourceECInstanceId
    JOIN bis.Element te
      ON te.ECInstanceId=erte.TargetECInstanceId
      WHERE se.FederationGuid IS NULL
      OR te.FederationGuid IS NULL`;
  const relReader = args.branch.createQueryReader(
    fedGuidLessRelsSql,
    undefined,
    { usePrimaryConn: true }
  );
  while (await relReader.step()) {
    const id: string = relReader.current.toRow().id;
    const aspectProps = IModelTransformer.initRelationshipProvenanceOptions(
      id,
      id,
      {
        isReverseSynchronization: false,
        targetScopeElementId: masterExternalSourceId,
        sourceDb: args.master,
        targetDb: args.branch,
        forceOldRelationshipProvenanceMethod: false,
      }
    );
    args.branch.elements.insertAspect(aspectProps);
  }

  if (args.createFedGuidsForMaster === true) {
    args.master.close();
    args.branch.close();
  }

  return {
    targetScopeElementId: masterExternalSourceId,
    masterExternalSourceId,
    masterRepositoryLinkId: masterRepoLinkId,
  };
}

function makeDbReopener(db: IModelDb) {
  const originalMode = db.isReadonly ? OpenMode.Readonly : OpenMode.ReadWrite;
  const dbPath = db.pathName;
  let reopenDb: (mode?: OpenMode) => IModelDb | Promise<IModelDb>;
  if (db instanceof BriefcaseDb)
    reopenDb = async (mode = originalMode) =>
      BriefcaseDb.open({
        fileName: dbPath,
        readonly: mode === OpenMode.Readonly,
      });
  else if (db instanceof StandaloneDb)
    reopenDb = (mode = originalMode) => StandaloneDb.openFile(dbPath, mode);
  else assert(false, `db type '${db.constructor.name}' not supported`);
  return reopenDb;
}
