/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/

import * as fs from "fs";
import * as path from "path";
import * as TestUtils from "../TestUtils";
import {
  BriefcaseDb,
  BriefcaseManager,
  ExternalSource,
  ExternalSourceIsInRepository,
  HubMock,
  IModelDb,
  IModelHost,
  PhysicalModel,
  PhysicalObject,
  PhysicalPartition,
  RepositoryLink,
  SnapshotDb,
  SpatialCategory,
} from "@itwin/core-backend";
import {
  HubWrappers,
  IModelTransformerTestUtils,
} from "../IModelTransformerUtils";
import { AccessToken } from "@itwin/core-bentley";
import {
  Code,
  ExternalSourceProps,
  IModel,
  PhysicalElementProps,
  QueryBinder,
  RepositoryLinkProps,
  SubCategoryAppearance,
} from "@itwin/core-common";
import { Point3d, YawPitchRollAngles } from "@itwin/core-geometry";
import { IModelTransformer } from "../../IModelTransformer";
process.env.TRANSFORMER_NO_STRICT_DEP_CHECK = "1"; // allow this monorepo's dev versions of core libs in transformer

// some json will be required later, but we don't want an eslint-disable line in the example code, so just disable for the file
/* eslint-disable @typescript-eslint/no-require-imports */

async function initializeBranch(
  myITwinId: string,
  masterIModelId: string,
  myAccessToken: AccessToken
) {
  // __PUBLISH_EXTRACT_START__ IModelBranchingOperations_initialize
  // download and open master
  const masterDbProps = await BriefcaseManager.downloadBriefcase({
    accessToken: myAccessToken,
    iTwinId: myITwinId,
    iModelId: masterIModelId,
  });
  const masterDb = await BriefcaseDb.open({ fileName: masterDbProps.fileName });

  // create a duplicate of master as a good starting point for our branch
  const branchIModelId = await IModelHost.hubAccess.createNewIModel({
    iTwinId: myITwinId,
    iModelName: "my-branch-imodel",
    version0: masterDb.pathName,
    noLocks: true, // you may prefer locks for your application
  });

  // download and open the new branch
  const branchDbProps = await BriefcaseManager.downloadBriefcase({
    accessToken: myAccessToken,
    iTwinId: myITwinId,
    iModelId: branchIModelId,
  });
  const branchDb = await BriefcaseDb.open({ fileName: branchDbProps.fileName });

  // create an external source and owning repository link to use as our *Target Scope Element* for future synchronizations
  const masterLinkRepoId = branchDb
    .constructEntity<RepositoryLink, RepositoryLinkProps>({
      classFullName: RepositoryLink.classFullName,
      code: RepositoryLink.createCode(
        branchDb,
        IModelDb.repositoryModelId,
        "example-code-value"
      ),
      model: IModelDb.repositoryModelId,
      url: "https://wherever-you-got-your-imodel.net",
      format: "iModel",
      repositoryGuid: masterDb.iModelId,
      description: "master iModel repository",
    })
    .insert();

  const masterExternalSourceId = branchDb
    .constructEntity<ExternalSource, ExternalSourceProps>({
      classFullName: ExternalSource.classFullName,
      model: IModelDb.rootSubjectId,
      code: Code.createEmpty(),
      repository: new ExternalSourceIsInRepository(masterLinkRepoId),
      connectorName: "iModel Transformer",
      connectorVersion: require("@itwin/imodel-transformer/package.json")
        .version,
    })
    .insert();

  // initialize the branch provenance
  const branchInitializer = new IModelTransformer(masterDb, branchDb, {
    // tells the transformer that we have a raw copy of a source and the target should receive
    // provenance from the source that is necessary for performing synchronizations in the future
    wasSourceIModelCopiedToTarget: true,
    // store the synchronization provenance in the scope of our representation of the external source, master
    targetScopeElementId: masterExternalSourceId,
  });
  await branchInitializer.process();
  branchInitializer.dispose();

  // save+push our changes to whatever hub we're using
  const description = "initialized branch iModel";
  branchDb.saveChanges(description);
  await branchDb.pushChanges({
    accessToken: myAccessToken,
    description,
  });
  // __PUBLISH_EXTRACT_END__

  return { masterDb, branchDb };
}

// we assume masterDb and branchDb have already been opened (see the first example)
async function forwardSyncMasterToBranch(
  masterDb: BriefcaseDb,
  branchDb: BriefcaseDb,
  myAccessToken: AccessToken
) {
  // __PUBLISH_EXTRACT_START__ IModelBranchingOperations_forwardSync
  const repositoryLinkId = branchDb.elements.queryElementIdByCode(
    RepositoryLink.createCode(
      masterDb,
      IModelDb.repositoryModelId,
      "example-code-value"
    )
  );
  let masterExternalSourceId;
  for await (const row of branchDb.createQueryReader(
    `SELECT ECInstanceId FROM ${ExternalSource.classFullName} WHERE Repository.Id=:id`,
    QueryBinder.from({ id: repositoryLinkId })
  )) {
    masterExternalSourceId = row.ECInstanceId;
  }
  const synchronizer = new IModelTransformer(masterDb, branchDb, {
    // read the synchronization provenance in the scope of our representation of the external source, master
    targetScopeElementId: masterExternalSourceId,
    // Presence of argsForProcessChanges even if empty is required to have process run 'processChanges' internally.
    argsForProcessChanges: {},
  });

  await synchronizer.process();
  synchronizer.dispose();
  // save and push
  const description = "updated branch with recent master changes";
  branchDb.saveChanges(description);
  await branchDb.pushChanges({
    accessToken: myAccessToken,
    description,
  });
  // __PUBLISH_EXTRACT_END__
}

async function reverseSyncBranchToMaster(
  branchDb: BriefcaseDb,
  masterDb: BriefcaseDb,
  myAccessToken: AccessToken
) {
  // __PUBLISH_EXTRACT_START__ IModelBranchingOperations_reverseSync
  // we assume masterDb and branchDb have already been opened (see the first example)
  const repositoryLinkId = branchDb.elements.queryElementIdByCode(
    RepositoryLink.createCode(
      masterDb,
      IModelDb.repositoryModelId,
      "example-code-value"
    )
  );
  let masterExternalSourceId;
  for await (const row of branchDb.createQueryReader(
    `SELECT ECInstanceId FROM ${ExternalSource.classFullName} WHERE Repository.Id=:id`,
    QueryBinder.from({ id: repositoryLinkId })
  )) {
    masterExternalSourceId = row.ECInstanceId;
  }
  const reverseSynchronizer = new IModelTransformer(branchDb, masterDb, {
    // read the synchronization provenance in the scope of our representation of the external source, master
    // "isReverseSynchronization" actually causes the provenance (and therefore the targetScopeElementId) to
    // be searched for from the source
    targetScopeElementId: masterExternalSourceId,
    // Presence of argsForProcessChanges even if empty is required to have process run 'processChanges' internally.
    argsForProcessChanges: {},
  });

  await reverseSynchronizer.process();
  reverseSynchronizer.dispose();
  // save and push
  const description = "merged changes from branch into master";
  masterDb.saveChanges(description);
  await masterDb.pushChanges({
    accessToken: myAccessToken,
    description,
  });
  // __PUBLISH_EXTRACT_END__
}

async function arbitraryEdit(
  db: BriefcaseDb,
  myAccessToken: AccessToken,
  description: string
) {
  const spatialCategoryCode = SpatialCategory.createCode(
    db,
    IModel.dictionaryId,
    "SpatialCategory1"
  );
  const physicalModelCode = PhysicalPartition.createCode(
    db,
    IModel.rootSubjectId,
    "PhysicalModel1"
  );
  let spatialCategoryId = db.elements.queryElementIdByCode(spatialCategoryCode);
  let physicalModelId = db.elements.queryElementIdByCode(physicalModelCode);
  if (physicalModelId === undefined || spatialCategoryId === undefined) {
    spatialCategoryId = SpatialCategory.insert(
      db,
      IModel.dictionaryId,
      "SpatialCategory1",
      new SubCategoryAppearance()
    );
    physicalModelId = PhysicalModel.insert(
      db,
      IModel.rootSubjectId,
      "PhysicalModel1"
    );
  }
  const physicalObjectProps: PhysicalElementProps = {
    classFullName: PhysicalObject.classFullName,
    model: physicalModelId,
    category: spatialCategoryId,
    code: new Code({
      spec: IModelDb.rootSubjectId,
      scope: IModelDb.rootSubjectId,
      value: `${arbitraryEdit.editCounter}`,
    }),
    userLabel: `${arbitraryEdit.editCounter}`,
    geom: IModelTransformerTestUtils.createBox(Point3d.create(1, 1, 1)),
    placement: {
      origin: Point3d.create(
        arbitraryEdit.editCounter,
        arbitraryEdit.editCounter,
        0
      ),
      angles: YawPitchRollAngles.createDegrees(0, 0, 0),
    },
  };
  arbitraryEdit.editCounter++;
  db.elements.insertElement(physicalObjectProps);
  db.saveChanges();
  await db.pushChanges({
    accessToken: myAccessToken,
    description,
  });
}

namespace arbitraryEdit {
  // eslint-disable-next-line prefer-const
  export let editCounter = 0;
}

describe.only("IModelBranchingOperations", () => {
  const version0Path = path.join(
    TestUtils.KnownTestLocations.outputDir,
    "branching-ops.bim"
  );

  before(async () => {
    HubMock.startup(
      "IModelBranchingOperations",
      TestUtils.KnownTestLocations.outputDir
    );
    if (fs.existsSync(version0Path)) fs.unlinkSync(version0Path);
    SnapshotDb.createEmpty(version0Path, {
      rootSubject: { name: "branching-ops" },
    }).close();
  });

  after(() => {
    HubMock.shutdown();
  });

  it("run branching operations", async () => {
    const myAccessToken = await HubWrappers.getAccessToken(
      TestUtils.TestUserType.Regular
    );
    const myITwinId = HubMock.iTwinId;
    const masterIModelId = await IModelHost.hubAccess.createNewIModel({
      iTwinId: myITwinId,
      iModelName: "my-branch-imodel",
      version0: version0Path,
      noLocks: true,
    });
    const { masterDb, branchDb } = await initializeBranch(
      myITwinId,
      masterIModelId,
      myAccessToken
    );
    await arbitraryEdit(masterDb, myAccessToken, "edit master");
    await forwardSyncMasterToBranch(masterDb, branchDb, myAccessToken);
    await arbitraryEdit(branchDb, myAccessToken, "edit branch");
    await reverseSyncBranchToMaster(branchDb, masterDb, myAccessToken);
    masterDb.close();
    branchDb.close();
  });
});
