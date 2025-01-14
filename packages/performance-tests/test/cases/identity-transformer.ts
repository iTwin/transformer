/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/
/*
 * Tests where we perform "identity" transforms, that is just rebuilding an entire identical iModel (minus IDs)
 * through the transformation process.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Logger, StopWatch } from "@itwin/core-bentley";
import { SnapshotDb } from "@itwin/core-backend";
import { TestCaseContext } from "./TestCaseContext";
import { initOutputFile, timed } from "../TestUtils";

const loggerCategory = "Transformer Performance Tests Identity";
const outputDir = path.join(__dirname, ".output");

export default async function identityTransformer(context: TestCaseContext) {
  const { sourceDb, transformerModule, addReport } = context;
  const targetPath = initOutputFile(
    `identity-${sourceDb.iModelId}-target.bim`,
    outputDir
  );
  const targetDb = SnapshotDb.createEmpty(targetPath, {
    rootSubject: { name: sourceDb.name },
  });
  let timer: StopWatch | undefined;
  if (!transformerModule.createIdentityTransform) {
    throw Error(
      "The createIdentityTransform method does not exist on the module."
    );
  }
  const transformer = await transformerModule.createIdentityTransform(
    sourceDb,
    targetDb
  );
  try {
    [timer] = await timed(async () => {
      await transformer.run();
    });
    Logger.logInfo(
      loggerCategory,
      `schema processing time: ${timer.elapsedSeconds}`
    );
  } catch (err: any) {
    Logger.logInfo(loggerCategory, `An error was encountered: ${err.message}`);
    const schemaDumpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "identity-test-schemas-dump-")
    );
    // eslint-disable-next-line @itwin/no-internal, deprecation/deprecation
    sourceDb.exportSchemas(schemaDumpDir);
    Logger.logInfo(loggerCategory, `dumped schemas to: ${schemaDumpDir}`);
    throw err;
  } finally {
    addReport(
      sourceDb.name,
      "time elapsed (seconds)",
      timer?.elapsedSeconds ?? -1
    );
    targetDb.close();
  }
}
