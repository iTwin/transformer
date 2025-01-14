/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/

import * as path from "path";
import * as fs from "fs";
import * as Yargs from "yargs";
import { assert, Guid, Logger, LogLevel } from "@itwin/core-bentley";
import { ProjectsAccessClient } from "@itwin/projects-client";
import {
  BriefcaseDb,
  IModelDb,
  IModelHost,
  IModelJsFs,
  SnapshotDb,
  StandaloneDb,
} from "@itwin/core-backend";
import {
  BriefcaseIdValue,
  ChangesetId,
  ChangesetProps,
  IModelVersion,
} from "@itwin/core-common";
import { TransformerLoggerCategory } from "@itwin/imodel-transformer";
import { NamedVersion } from "@itwin/imodels-client-authoring";
import { ElementUtils } from "./ElementUtils";
import { IModelHubUtils, IModelTransformerTestAppHost } from "./IModelHubUtils";
// eslint-disable-next-line @typescript-eslint/no-redeclare
import { loggerCategory, Transformer, TransformerOptions } from "./Transformer";
import * as dotenv from "dotenv";
import * as dotenvExpand from "dotenv-expand";

import "source-map-support/register";

const acquireAccessToken = async () =>
  IModelTransformerTestAppHost.acquireAccessToken();

void (async () => {
  let targetDb: IModelDb, sourceDb: IModelDb;
  try {
    const envResult = dotenv.config({
      path: path.resolve(__dirname, "../.env"),
    });
    if (!envResult.error) {
      dotenvExpand(envResult);
    }

    const args = Yargs(process.argv.slice(2))
      .usage(
        [
          "Transform the specified source iModel into a new target iModel.",
          "You must set up a .env file to connect to an online iModel, see the .env.template file to do so.",
        ].join("\n")
      )
      .strict()
      .options({
        hub: {
          desc: "The iModelHub environment: prod | qa | dev",
          type: "string",
          default: "prod",
        },

        // used if the source iModel is already locally cached
        sourceFile: {
          desc:
            "(deprecated, use any of sourceStandalone, sourceSnapshot or sourceBriefcasePath instead)." +
            " The full path to the source iModel, to be opened as a snapshot",
          type: "string",
        },
        sourceSnapshot: {
          desc: "The full path to the source iModel, to be opened as a snapshot iModel",
          type: "string",
        },
        sourceStandalone: {
          desc: "The full path to the source iModel, to be opened as a standalone iModel",
          type: "string",
        },
        sourceBriefcasePath: {
          desc: "The full path to the source iModel, to be opened as a briefcase iModel",
          type: "string",
        },

        // used if the source iModel is on iModelHub
        sourceITwinId: {
          desc: "The iModelHub iTwin containing the source iModel",
          type: "string",
        },
        sourceIModelId: {
          desc: "The guid of the source iModel",
          type: "string",
        },
        sourceIModelName: {
          desc: "The name of the source iModel",
          type: "string",
        },
        sourceStartChangesetId: {
          desc: "The starting changeset of the source iModel to transform",
          type: "string",
        },
        sourceStartChangesetIndex: {
          desc: "The starting changeset of the source iModel to transform",
          type: "number",
        },
        sourceEndChangesetId: {
          desc: "The ending changeset of the source iModel to transform",
          type: "string",
        },
        sourceEndChangesetIndex: {
          desc: "The ending changeset of the source iModel to transform",
          type: "number",
        },

        // used if the target iModel is a new snapshot
        targetDestination: {
          desc: "The destination path where to create the target iModel",
          type: "string",
        },
        // used if the target iModel is a standalone db
        targetFile: {
          desc: "The full path to the target iModel",
          type: "string",
        },
        targetStandaloneDestination: {
          desc: "The destination path where to create a standalone iModel from the targetITwin",
          type: "string",
        },
        // used if the target iModel is a non-standardly cached briefcase
        targetBriefcasePath: {
          desc: "The full path to the target iModel, to be opened as a briefcase iModel",
          type: "string",
        },
        // used if the target iModel is on iModelHub
        targetITwinId: {
          desc: "The iModelHub iTwin containing the target iModel",
          type: "string",
        },
        targetIModelId: {
          desc: "The guid of the target iModel",
          type: "string",
        },
        targetIModelName: {
          desc: "The name of the target iModel",
          type: "string",
        },

        // print/debug options
        logChangesets: {
          desc: "If true, log the list of changesets",
          type: "boolean",
          default: false,
        },
        logNamedVersions: {
          desc: "If true, log the list of named versions",
          type: "boolean",
          default: false,
        },
        logProvenanceScopes: {
          desc: "If true, log the provenance scopes in the source and target iModels",
          type: "boolean",
          default: false,
        },
        logTransformer: {
          alias: ["verbose", "v"],
          desc: "If true, turn on verbose logging for iModel transformation",
          type: "boolean",
          default: false,
        },
        validation: {
          desc: "If true, perform extra and potentially expensive validation to assist with finding issues and confirming results",
          type: "boolean",
          default: false,
        },

        // transformation options
        simplifyElementGeometry: {
          desc: "Simplify element geometry upon import into target iModel",
          type: "boolean",
          default: false,
        },
        combinePhysicalModels: {
          desc: "Combine all source PhysicalModels into a single PhysicalModel in the target iModel",
          type: "boolean",
          default: false,
        },
        exportViewDefinition: {
          desc: "Only export elements that would be visible using the specified ViewDefinition Id",
          type: "string",
        },
        deleteUnusedGeometryParts: {
          desc: "Delete unused GeometryParts from the target iModel",
          type: "boolean",
          default: false,
        },
        excludeSubCategories: {
          desc: "Exclude geometry in the specified SubCategories (names with comma separators) from the target iModel",
          type: "string",
        },
        excludeCategories: {
          desc: "Exclude a categories (names with comma separators) and their elements from the target iModel",
          type: "string",
        },
        noProvenance: {
          desc: "If true, IModelTransformer should not record its provenance.",
          type: "boolean",
          default: false,
        },
        includeSourceProvenance: {
          desc: "Include existing provenance from the source iModel in the target iModel",
          type: "boolean",
          default: false,
        },
        isolateElements: {
          desc: "transform filtering all element/models that aren't part of the logical path to a set of comma-separated element ids",
          type: "string",
        },
        isolateTrees: {
          desc: "transform filtering all element/models that aren't part of the logical path to a set of comma-separated element ids, or one of their children",
          type: "string",
        },
        loadSourceGeometry: {
          desc: "load geometry from the source as JSON while transforming, for easier (but not performant) transforming of geometry",
          type: "boolean",
          default: false,
        },
        cloneUsingJsonGeometry: {
          desc: "sets cloneUsingBinaryGeometry in the transformer options to true, which is slower but allows simple editing of geometry in javascript.",
          type: "boolean",
          default: false,
        },
        danglingReferencesBehavior: {
          desc: "sets danglingReferencesBehavior in the transformer options",
          default: "reject" as const,
          choices: ["reject", "ignore"] as const,
        },
      })
      .parseSync();

    IModelHubUtils.setHubEnvironment(args.hub);

    await IModelTransformerTestAppHost.startup();

    Logger.initializeToConsole();
    Logger.setLevelDefault(LogLevel.Error);
    Logger.setLevel(loggerCategory, LogLevel.Info);

    if (args.logTransformer) {
      // optionally enable verbose transformation logging
      Logger.setLevel(TransformerLoggerCategory.IModelExporter, LogLevel.Trace);
      Logger.setLevel(TransformerLoggerCategory.IModelImporter, LogLevel.Trace);
      Logger.setLevel(
        TransformerLoggerCategory.IModelTransformer,
        LogLevel.Trace
      );
    }

    let iTwinAccessClient: ProjectsAccessClient | undefined;
    const processChanges =
      args.sourceStartChangesetIndex || args.sourceStartChangesetId;

    if (args.sourceITwinId || args.targetITwinId) {
      iTwinAccessClient = new ProjectsAccessClient();
    }

    if (args.sourceITwinId) {
      // source is from iModelHub
      assert(
        undefined !== iTwinAccessClient,
        "iTwinAccessClient must have been defined if sourceITwinId is allowed, if you are seeing this, it is a bug"
      );
      assert(
        undefined !== args.sourceIModelId,
        "if you provide a sourceITwinId, you must provide a sourceIModelId"
      );
      const sourceITwinId = Guid.normalize(args.sourceITwinId);
      const sourceIModelId = Guid.normalize(args.sourceIModelId);
      let sourceEndVersion = IModelVersion.latest();
      Logger.logInfo(loggerCategory, `sourceITwinId=${sourceITwinId}`);
      Logger.logInfo(loggerCategory, `sourceIModelId=${sourceIModelId}`);
      if (args.sourceStartChangesetIndex || args.sourceStartChangesetId) {
        assert(
          !(args.sourceStartChangesetIndex && args.sourceStartChangesetId),
          "Pick single way to specify starting changeset"
        );
        if (args.sourceStartChangesetIndex) {
          args.sourceStartChangesetId = await IModelHubUtils.queryChangesetId(
            await acquireAccessToken(),
            sourceIModelId,
            args.sourceStartChangesetIndex
          );
        } else {
          args.sourceStartChangesetIndex =
            await IModelHubUtils.queryChangesetIndex(
              await acquireAccessToken(),
              sourceIModelId,
              args.sourceStartChangesetId as ChangesetId
            );
        }
        Logger.logInfo(
          loggerCategory,
          `sourceStartChangesetIndex=${args.sourceStartChangesetIndex}`
        );
        Logger.logInfo(
          loggerCategory,
          `sourceStartChangesetId=${args.sourceStartChangesetId}`
        );
      }
      if (args.sourceEndChangesetIndex || args.sourceEndChangesetId) {
        assert(
          !(args.sourceEndChangesetIndex && args.sourceEndChangesetId),
          "Pick single way to specify ending changeset"
        );
        if (args.sourceEndChangesetIndex) {
          args.sourceEndChangesetId = await IModelHubUtils.queryChangesetId(
            await acquireAccessToken(),
            sourceIModelId,
            args.sourceEndChangesetIndex
          );
        } else {
          args.sourceEndChangesetIndex =
            await IModelHubUtils.queryChangesetIndex(
              await acquireAccessToken(),
              sourceIModelId,
              args.sourceEndChangesetId as ChangesetId
            );
        }
        sourceEndVersion = IModelVersion.asOfChangeSet(
          args.sourceEndChangesetId as ChangesetId
        );
        Logger.logInfo(
          loggerCategory,
          `sourceEndChangesetIndex=${args.sourceEndChangesetIndex}`
        );
        Logger.logInfo(
          loggerCategory,
          `sourceEndChangesetId=${args.sourceEndChangesetId}`
        );
      }

      if (args.logChangesets) {
        await IModelHubUtils.forEachChangeset(
          await acquireAccessToken(),
          sourceIModelId,
          (changeset: ChangesetProps) => {
            Logger.logInfo(
              loggerCategory,
              `sourceChangeset: index=${changeset.index}, id="${changeset.id}", description="${changeset.description}"}`
            );
          }
        );
      }

      if (args.logNamedVersions) {
        await IModelHubUtils.forEachNamedVersion(
          await acquireAccessToken(),
          sourceIModelId,
          (namedVersion: NamedVersion) => {
            Logger.logInfo(
              loggerCategory,
              `sourceNamedVersion: id="${namedVersion.id}", changesetId="${namedVersion.changesetId}", name="${namedVersion.name}"`
            );
          }
        );
      }

      sourceDb = await IModelHubUtils.downloadAndOpenBriefcase({
        iTwinId: sourceITwinId,
        iModelId: sourceIModelId,
        asOf: sourceEndVersion.toJSON(),
        briefcaseId: BriefcaseIdValue.Unassigned, // A "pull only" briefcase can be used since the sourceDb is opened read-only
      });
    } else {
      // source is local
      assert(
        (args.sourceFile ? 1 : 0) +
          (args.sourceSnapshot ? 1 : 0) +
          (args.sourceStandalone ? 1 : 0) +
          (args.sourceBriefcasePath ? 1 : 0) ===
          1,
        "must set exactly one of sourceFile, sourceSnapshot, sourceStandalone, sourceBriefcasePath"
      );

      const dbOpen: (s: string) => IModelDb | Promise<IModelDb> =
        args.sourceFile
          ? SnapshotDb.openFile.bind(SnapshotDb)
          : args.sourceSnapshot
            ? SnapshotDb.openFile.bind(SnapshotDb)
            : args.sourceStandalone
              ? StandaloneDb.openFile.bind(StandaloneDb)
              : args.sourceBriefcasePath
                ? async (file: string) => BriefcaseDb.open({ fileName: file })
                : (assert(
                    false,
                    "No remote iModel id arguments, nor local iModel path arguments"
                  ) as never);

      const sourceFile = path.normalize(
        args.sourceFile ??
          args.sourceSnapshot ??
          args.sourceStandalone ??
          args.sourceBriefcasePath ??
          (assert(
            false,
            "unreachable; one of these was set according to the above assert"
          ) as never)
      );

      Logger.logInfo(loggerCategory, `sourceFile=${sourceFile}`);
      sourceDb = await dbOpen(sourceFile);
    }

    if (args.validation) {
      // validate that there are no issues with the sourceDb to ensure that IModelTransformer is starting from a consistent state
      ElementUtils.validateCategorySelectors(sourceDb);
      ElementUtils.validateModelSelectors(sourceDb);
      ElementUtils.validateDisplayStyles(sourceDb);
    }

    if (args.targetITwinId) {
      // target is from iModelHub
      assert(
        undefined !== args.targetIModelId ||
          undefined !== args.targetIModelName,
        "must be able to identify the iModel by either name or id"
      );
      const targetITwinId = Guid.normalize(args.targetITwinId);
      let targetIModelId = args.targetIModelId
        ? Guid.normalize(args.targetIModelId)
        : undefined;
      if (undefined !== args.targetIModelName) {
        assert(
          undefined === targetIModelId,
          "should not specify targetIModelId if targetIModelName is specified"
        );
        targetIModelId = await IModelHubUtils.queryIModelId(
          await acquireAccessToken(),
          targetITwinId,
          args.targetIModelName
        );
        if (args.clean && undefined !== targetIModelId) {
          await IModelHost.hubAccess.deleteIModel({
            accessToken: await acquireAccessToken(),
            iTwinId: targetITwinId,
            iModelId: targetIModelId,
          });
          targetIModelId = undefined;
        }
        if (undefined === targetIModelId) {
          // create target iModel if it doesn't yet exist or was just cleaned/deleted above
          targetIModelId = await IModelHost.hubAccess.createNewIModel({
            accessToken: await acquireAccessToken(),
            iTwinId: targetITwinId,
            iModelName: args.targetIModelName,
          });
        }
      }
      assert(
        undefined !== targetIModelId,
        "if you provide a sourceITwinId, you must provide a sourceIModelId"
      );
      Logger.logInfo(loggerCategory, `targetITwinId=${targetITwinId}`);
      Logger.logInfo(loggerCategory, `targetIModelId=${targetIModelId}`);

      if (args.logChangesets) {
        await IModelHubUtils.forEachChangeset(
          await acquireAccessToken(),
          targetIModelId,
          (changeset: ChangesetProps) => {
            Logger.logInfo(
              loggerCategory,
              `targetChangeset:  index="${changeset.index}", id="${changeset.id}", description="${changeset.description}"`
            );
          }
        );
      }

      if (args.logNamedVersions) {
        await IModelHubUtils.forEachNamedVersion(
          await acquireAccessToken(),
          targetIModelId,
          (namedVersion: NamedVersion) => {
            Logger.logInfo(
              loggerCategory,
              `targetNamedVersion: id="${namedVersion.id}", changesetId="${namedVersion.changesetId}", name="${namedVersion.name}"`
            );
          }
        );
      }

      targetDb = await IModelHubUtils.downloadAndOpenBriefcase({
        iTwinId: targetITwinId,
        fileName: process.env.FORCE_BRIEFCASE_NAME,
        iModelId: targetIModelId,
      });
      const fileName = targetDb.pathName;

      if (args.targetStandaloneDestination) {
        fs.copyFileSync(fileName, args.targetStandaloneDestination);
        /* eslint-enable deprecation/deprecation */
        targetDb.close();
        StandaloneDb.convertToStandalone(args.targetStandaloneDestination);
        await StandaloneDb.upgradeSchemas({ fileName });
        targetDb = StandaloneDb.openFile(args.targetStandaloneDestination);
      }
    } else if (args.targetDestination) {
      const targetDestination = path.normalize(args.targetDestination);
      // assert(!processChanges, "cannot process changes because targetDestination creates a new iModel");
      // clean target output destination before continuing (regardless of args.clean value)
      if (IModelJsFs.existsSync(targetDestination)) {
        IModelJsFs.removeSync(targetDestination);
      }
      // use StandaloneDb instead of SnapshotDb to enable processChanges testing
      targetDb = StandaloneDb.createEmpty(targetDestination, {
        rootSubject: { name: `${sourceDb.rootSubject.name}-Transformed` },
        ecefLocation: sourceDb.ecefLocation,
      });
    } else if (args.targetFile) {
      // target is a local standalone file
      targetDb = StandaloneDb.openFile(args.targetFile);
    } else if (args.targetBriefcasePath) {
      // target is a local briefcase file
      targetDb = await BriefcaseDb.open({ fileName: args.targetBriefcasePath });
    } else {
      assert(false, "bad target argument");
    }

    if (args.logProvenanceScopes) {
      const sourceScopeIds = ElementUtils.queryProvenanceScopeIds(sourceDb);
      if (sourceScopeIds.size === 0) {
        Logger.logInfo(loggerCategory, "Source Provenance Scope: Not Found");
      } else {
        sourceScopeIds.forEach((scopeId) =>
          Logger.logInfo(
            loggerCategory,
            `Source Provenance Scope: ${scopeId} ${sourceDb.elements
              .getElement(scopeId)
              .getDisplayLabel()}`
          )
        );
      }
      const targetScopeIds = ElementUtils.queryProvenanceScopeIds(targetDb);
      if (targetScopeIds.size === 0) {
        Logger.logInfo(loggerCategory, "Target Provenance Scope: Not Found");
      } else {
        targetScopeIds.forEach((scopeId) =>
          Logger.logInfo(
            loggerCategory,
            `Target Provenance Scope: ${scopeId} ${targetDb.elements
              .getElement(scopeId)
              .getDisplayLabel()}`
          )
        );
      }
    }

    const transformerOptions: TransformerOptions = {
      ...args,
      cloneUsingBinaryGeometry: !args.cloneUsingJsonGeometry,
      excludeSubCategories: args.excludeSubCategories?.split(","),
      excludeCategories: args.excludeCategories?.split(","),
    };

    if (processChanges) {
      assert(undefined !== args.sourceStartChangesetId);
      await Transformer.transformChanges(
        sourceDb,
        targetDb,
        args.sourceStartChangesetId,
        transformerOptions
      );
    } else if (
      args.isolateElements !== undefined ||
      args.isolateTrees !== undefined
    ) {
      const isolateTrees = args.isolateTrees !== undefined;
      const isolateArg = args.isolateElements ?? args.isolateTrees;
      assert(isolateArg !== undefined);
      const isolateList = isolateArg.split(",");
      const transformer = await Transformer.transformIsolated(
        sourceDb,
        targetDb,
        isolateList,
        isolateTrees,
        transformerOptions
      );
      Logger.logInfo(
        loggerCategory,
        [
          "remapped elements:",
          isolateList
            .map(
              (id) => `${id}=>${transformer.context.findTargetElementId(id)}`
            )
            .join(", "),
        ].join("\n")
      );
      transformer.dispose();
    } else {
      await Transformer.transformAll(sourceDb, targetDb, transformerOptions);
    }

    if (args.exportViewDefinition) {
      ElementUtils.insertViewDefinition(targetDb, "Default", true);
    }

    if (args.validation) {
      // validate that there are no issues with the targetDb after transformation
      ElementUtils.validateCategorySelectors(targetDb);
      ElementUtils.validateModelSelectors(targetDb);
      ElementUtils.validateDisplayStyles(targetDb);
    }
  } catch (error: any) {
    process.stdout.write(`${error.message}\n${error.stack}`);
  } finally {
    if (targetDb! instanceof BriefcaseDb)
      await targetDb.locks.releaseAllLocks();
    targetDb!.close();
    sourceDb!.close();
    await IModelHost.shutdown();
    process.exit();
  }
})();
