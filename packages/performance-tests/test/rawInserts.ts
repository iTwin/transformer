/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/
import {
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  Element,
  ElementGroupsMembers,
  SnapshotDb,
  StandaloneDb,
} from "@itwin/core-backend";
import { IModelTransformer } from "@itwin/imodel-transformer";
import { IModelTransformerTestUtils } from "@itwin/imodel-transformer/lib/cjs/test/IModelTransformerUtils";
import { Logger, OpenMode } from "@itwin/core-bentley";
import { Reporter } from "@itwin/perf-tools";
import { TestIModel } from "./TestContext";
import { generateTestIModel } from "./iModelUtils";
import { initOutputFile, timed } from "./TestUtils";
import assert from "assert";
import path from "path";

const loggerCategory = "Raw Inserts";
const outputDir = path.join(__dirname, ".output");

const iModelName = "Many PhysicalObjects and Relationships";

const ELEM_COUNT = 100_000;
assert(ELEM_COUNT % 2 === 0, "elem count must be divisible by 2");

export default async function rawInserts(
  reporter: Reporter,
  branchName: string
) {
  Logger.logInfo(loggerCategory, "starting 150k entity inserts");

  let testIModel: TestIModel | undefined;
  const [insertsTimer] = timed(() => {
    testIModel = generateTestIModel({
      numElements: 100_000,
      fedGuids: true,
      fileName: "RawInserts-source.bim",
    });
  });

  if (testIModel === undefined)
    throw Error("Generated iModel not correctly defined"); // needed because TS does not know that timer will run before insertsTimer
  const fileName = await testIModel.getFileName();
  const sourceDb = StandaloneDb.openFile(fileName, OpenMode.ReadWrite);

  reporter.addEntry(
    "populate by insert",
    iModelName,
    "time elapsed (seconds)",
    insertsTimer?.elapsedSeconds ?? -1,
    {
      "Element Count": IModelTransformerTestUtils.count(
        sourceDb,
        Element.classFullName
      ),
      "Relationship Count": IModelTransformerTestUtils.count(
        sourceDb,
        ElementGroupsMembers.classFullName
      ),
      "Branch Name": branchName,
    }
  );

  sourceDb.saveChanges();

  Logger.logInfo(
    loggerCategory,
    "Done. Starting with-provenance transformation of same content"
  );

  const targetPath = initOutputFile("RawInserts-Target.bim", outputDir);
  const targetDb = SnapshotDb.createEmpty(targetPath, {
    rootSubject: { name: "RawInsertsTarget" },
  });
  const transformerWithProv = new IModelTransformer(sourceDb, targetDb, {
    noProvenance: false,
  });

  const [transformWithProvTimer] = await timed(async () => {
    await transformerWithProv.process();
  });

  reporter.addEntry(
    "populate by transform (adding provenance)",
    iModelName,
    "time elapsed (seconds)",
    transformWithProvTimer?.elapsedSeconds ?? -1,
    {
      "Element Count": IModelTransformerTestUtils.count(
        sourceDb,
        Element.classFullName
      ),
      "Relationship Count": IModelTransformerTestUtils.count(
        sourceDb,
        ElementGroupsMembers.classFullName
      ),
      "Branch Name": branchName,
    }
  );

  Logger.logInfo(
    loggerCategory,
    "Done. Starting without-provenance transformation of same content"
  );

  const targetNoProvPath = initOutputFile(
    "RawInserts-TargetNoProv.bim",
    outputDir
  );
  const targetNoProvDb = SnapshotDb.createEmpty(targetNoProvPath, {
    rootSubject: { name: "RawInsertsTarget" },
  });
  const transformerNoProv = new IModelTransformer(sourceDb, targetNoProvDb, {
    noProvenance: true,
  });

  const [transformNoProvTimer] = await timed(async () => {
    await transformerNoProv.process();
  });

  reporter.addEntry(
    "populate by transform",
    iModelName,
    "time elapsed (seconds)",
    transformNoProvTimer?.elapsedSeconds ?? -1,
    {
      "Element Count": IModelTransformerTestUtils.count(
        sourceDb,
        Element.classFullName
      ),
      "Relationship Count": IModelTransformerTestUtils.count(
        sourceDb,
        ElementGroupsMembers.classFullName
      ),
      "Branch Name": branchName,
    }
  );

  sourceDb.close();
  targetDb.close();
  targetNoProvDb.close();
}
