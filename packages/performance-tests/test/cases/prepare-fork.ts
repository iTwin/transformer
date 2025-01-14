/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Logger, StopWatch } from "@itwin/core-bentley";
import { StandaloneDb } from "@itwin/core-backend";
import { TestCaseContext } from "./TestCaseContext";
import { initOutputFile, timed } from "../TestUtils";
import { setToStandalone } from "../iModelUtils";

const loggerCategory = "Transformer Performance Tests Prepare Fork";
const outputDir = path.join(__dirname, ".output");

export default async function prepareFork(context: TestCaseContext) {
  const { sourceDb, transformerModule, addReport } = context;
  // create a duplicate of master for branch
  const branchPath = initOutputFile(
    `PrepareFork-${sourceDb.name}-target.bim`,
    outputDir
  );
  const filePath = sourceDb.pathName;
  fs.copyFileSync(filePath, branchPath);
  setToStandalone(branchPath);
  const branchDb = StandaloneDb.openFile(branchPath);

  let timer: StopWatch | undefined;
  if (!transformerModule.createForkInitTransform) {
    throw Error(
      "The createForkInitTransform method does not exist on the module."
    );
  }
  // initialize the branch provenance
  const branchInitializer = await transformerModule.createForkInitTransform(
    sourceDb,
    branchDb
  );
  try {
    [timer] = await timed(async () => {
      await branchInitializer.run();
    });

    Logger.logInfo(
      loggerCategory,
      `Prepare Fork time: ${timer.elapsedSeconds}`
    );
  } catch (err: any) {
    Logger.logInfo(loggerCategory, `An error was encountered: ${err.message}`);
    const schemaDumpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "fork-test-schemas-dump-")
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
    branchDb.close();
  }
}
