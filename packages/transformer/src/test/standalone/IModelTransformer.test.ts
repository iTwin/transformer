/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/

import { assert, expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as Semver from "semver";
import * as sinon from "sinon";
import {
  CategorySelector,
  DisplayStyle3d,
  DocumentListModel,
  Drawing,
  DrawingCategory,
  DrawingGraphic,
  DrawingModel,
  ECSqlStatement,
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  Element,
  ElementMultiAspect,
  ElementOwnsChildElements,
  ElementOwnsExternalSourceAspects,
  ElementOwnsMultiAspects,
  ElementOwnsUniqueAspect,
  ElementRefersToElements,
  ElementUniqueAspect,
  ExternalSourceAspect,
  GenericPhysicalMaterial,
  GeometricElement,
  IModelDb,
  IModelElementCloneContext,
  IModelHost,
  IModelJsFs,
  InformationRecordModel,
  InformationRecordPartition,
  LinkElement,
  Model,
  ModelSelector,
  OrthographicViewDefinition,
  PhysicalModel,
  PhysicalObject,
  PhysicalPartition,
  PhysicalType,
  Relationship,
  RenderMaterialElement,
  RepositoryLink,
  Schema,
  SnapshotDb,
  SpatialCategory,
  StandaloneDb,
  SubCategory,
  Subject,
  Texture,
} from "@itwin/core-backend";
import * as coreBackendPkgJson from "@itwin/core-backend/package.json";
import * as ECSchemaMetaData from "@itwin/ecschema-metadata";

import * as TestUtils from "../TestUtils";
import {
  DbResult,
  Guid,
  Id64,
  Id64String,
  Logger,
  LoggingMetaData,
  LogLevel,
  OpenMode,
} from "@itwin/core-bentley";
import {
  AxisAlignedBox3d,
  BriefcaseIdValue,
  Code,
  CodeScopeSpec,
  CodeSpec,
  ColorDef,
  CreateIModelProps,
  DefinitionElementProps,
  ElementAspectProps,
  ElementProps,
  ExternalSourceAspectProps,
  GeometricElement2dProps,
  ImageSourceFormat,
  IModel,
  IModelError,
  InformationPartitionElementProps,
  ModelProps,
  PhysicalElementProps,
  Placement3d,
  ProfileOptions,
  QueryRowFormat,
  RelatedElement,
  RelationshipProps,
  RepositoryLinkProps,
} from "@itwin/core-common";
import {
  Point3d,
  Range3d,
  StandardViewIndex,
  Transform,
  YawPitchRollAngles,
} from "@itwin/core-geometry";
import { IModelExporter, IModelExportHandler } from "../../IModelExporter";
import {
  IModelTransformer,
  IModelTransformOptions,
} from "../../IModelTransformer";
import { TransformerLoggerCategory } from "../../TransformerLoggerCategory";
import {
  AspectTrackingImporter,
  AspectTrackingTransformer,
  assertIdentityTransformation,
  AssertOrderTransformer,
  ClassCounter,
  cmpProfileVersion,
  FilterByViewTransformer,
  getProfileVersion,
  IModelToTextFileExporter,
  IModelTransformer3d,
  IModelTransformerTestUtils,
  PhysicalModelConsolidator,
  RecordingIModelImporter,
  runWithCpuProfiler,
  TestIModelTransformer,
  TransformerExtensiveTestScenario,
} from "../IModelTransformerUtils";
import { KnownTestLocations } from "../TestUtils/KnownTestLocations";

import "./TransformerTestStartup"; // calls startup/shutdown IModelHost before/after all tests
import { SchemaLoader } from "@itwin/ecschema-metadata";
import { DetachedExportElementAspectsStrategy } from "../../DetachedExportElementAspectsStrategy";
import { SchemaTestUtils } from "../TestUtils";

describe("IModelTransformer", () => {
  const outputDir = path.join(
    KnownTestLocations.outputDir,
    "IModelTransformer"
  );

  /** Instead creating empty snapshots and populating them via routines for new tests incurring a wait,
   * if it's going to be reused, store it here as a getter and a promise that `SnapshotDb.createFrom` can be called on
   */
  class ReusedSnapshots {
    private static _extensiveTestScenario: Promise<SnapshotDb> | undefined;

    public static get extensiveTestScenario(): Promise<SnapshotDb> {
      return (this._extensiveTestScenario ??= (async () => {
        const dbPath = IModelTransformerTestUtils.prepareOutputFile(
          "IModelTransformer",
          "ReusedExtensiveTestScenario.bim"
        );
        const db = SnapshotDb.createEmpty(dbPath, {
          rootSubject: { name: "ReusedExtensiveTestScenario" },
          createClassViews: true,
        });
        await TransformerExtensiveTestScenario.prepareDb(db);
        TransformerExtensiveTestScenario.populateDb(db);
        db.saveChanges();
        return db;
      })());
    }

    public static async cleanup() {
      (await this._extensiveTestScenario)?.close();
    }
  }

  before(async () => {
    if (!IModelJsFs.existsSync(KnownTestLocations.outputDir)) {
      IModelJsFs.mkdirSync(KnownTestLocations.outputDir);
    }
    if (!IModelJsFs.existsSync(outputDir)) {
      IModelJsFs.mkdirSync(outputDir);
    }
  });

  beforeEach(async () => {
    // initialize logging
    if (process.env.LOG_TRANSFORMER_IN_TESTS) {
      Logger.initializeToConsole();
      Logger.setLevelDefault(LogLevel.Error);
      Logger.setLevel(TransformerLoggerCategory.IModelExporter, LogLevel.Trace);
      Logger.setLevel(TransformerLoggerCategory.IModelImporter, LogLevel.Trace);
      Logger.setLevel(
        TransformerLoggerCategory.IModelTransformer,
        LogLevel.Trace
      );
    }
  });

  after(async () => {
    await ReusedSnapshots.cleanup();
  });

  it("should transform changes from source to target", async () => {
    // Source IModelDb
    const sourceDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "TestIModelTransformer-Source.bim"
    );
    const sourceDb = SnapshotDb.createFrom(
      await ReusedSnapshots.extensiveTestScenario,
      sourceDbFile
    );
    // Target IModelDb
    const targetDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "TestIModelTransformer-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "TestIModelTransformer-Target" },
    });
    await TransformerExtensiveTestScenario.prepareTargetDb(targetDb);
    targetDb.saveChanges();

    const numSourceUniqueAspects = count(
      sourceDb,
      ElementUniqueAspect.classFullName
    );
    const numSourceMultiAspects = count(
      sourceDb,
      ElementMultiAspect.classFullName
    );
    const numSourceRelationships = count(
      sourceDb,
      ElementRefersToElements.classFullName
    );
    assert.isAtLeast(numSourceUniqueAspects, 1);
    assert.isAtLeast(numSourceMultiAspects, 1);
    assert.isAtLeast(numSourceRelationships, 1);

    if (true) {
      // initial import
      Logger.logInfo(
        TransformerLoggerCategory.IModelTransformer,
        "=============="
      );
      Logger.logInfo(
        TransformerLoggerCategory.IModelTransformer,
        "Initial Import"
      );
      Logger.logInfo(
        TransformerLoggerCategory.IModelTransformer,
        "=============="
      );
      const targetImporter = new RecordingIModelImporter(targetDb);
      const transformer = new TestIModelTransformer(sourceDb, targetImporter, {
        forceExternalSourceAspectProvenance: true,
      });
      assert.isTrue(transformer.context.isBetweenIModels);
      await transformer.process();
      assert.isAtLeast(targetImporter.numModelsInserted, 1);
      assert.equal(targetImporter.numModelsUpdated, 0);
      assert.isAtLeast(targetImporter.numElementsInserted, 1);
      assert.isAtLeast(targetImporter.numElementsUpdated, 1);
      assert.equal(targetImporter.numElementsExplicitlyDeleted, 0);
      assert.isAtLeast(targetImporter.numElementAspectsInserted, 1);
      assert.equal(targetImporter.numElementAspectsUpdated, 0);
      assert.isAtLeast(targetImporter.numRelationshipsInserted, 1);
      assert.equal(targetImporter.numRelationshipsUpdated, 0);
      assert.isAtLeast(
        count(targetDb, ElementRefersToElements.classFullName),
        1
      );
      assert.isAtLeast(
        count(targetDb, InformationRecordPartition.classFullName),
        1
      );
      assert.isAtLeast(
        count(targetDb, InformationRecordModel.classFullName),
        1
      );
      assert.isAtLeast(
        count(
          targetDb,
          "ExtensiveTestScenarioTarget:PhysicalPartitionIsTrackedByRecords"
        ),
        1
      );
      assert.isAtLeast(
        count(targetDb, "ExtensiveTestScenarioTarget:AuditRecord"),
        1
      );
      assert.equal(
        3,
        count(targetDb, "ExtensiveTestScenarioTarget:TargetInformationRecord")
      );
      targetDb.saveChanges();
      TransformerExtensiveTestScenario.assertTargetDbContents(
        sourceDb,
        targetDb,
        { expectEsas: true }
      );
      transformer.context.dump(`${targetDbFile}.context.txt`);
      transformer.dispose();
    }

    const numTargetElements = count(targetDb, Element.classFullName);
    const numTargetUniqueAspects = count(
      targetDb,
      ElementUniqueAspect.classFullName
    );
    const numTargetMultiAspects = count(
      targetDb,
      ElementMultiAspect.classFullName
    );
    const numTargetExternalSourceAspects = count(
      targetDb,
      ExternalSourceAspect.classFullName
    );
    const numTargetRelationships = count(
      targetDb,
      ElementRefersToElements.classFullName
    );
    assert.isAtLeast(numTargetElements, 1);
    assert.isAtLeast(numTargetUniqueAspects, 1);
    assert.isAtLeast(numTargetMultiAspects, 1);
    assert.isAtLeast(numTargetRelationships, 1);

    if (true) {
      // tests of IModelExporter
      // test #1 - export structure
      const exportFileName: string =
        IModelTransformerTestUtils.prepareOutputFile(
          "IModelTransformer",
          "TestIModelTransformer-Source-Export.txt"
        );
      assert.isFalse(IModelJsFs.existsSync(exportFileName));
      const exporter = new IModelToTextFileExporter(sourceDb, exportFileName);
      await exporter.export();
      assert.isTrue(IModelJsFs.existsSync(exportFileName));

      // test #2 - count occurrences of classFullNames
      const classCountsFileName: string =
        IModelTransformerTestUtils.prepareOutputFile(
          "IModelTransformer",
          "TestIModelTransformer-Source-Counts.txt"
        );
      assert.isFalse(IModelJsFs.existsSync(classCountsFileName));
      const classCounter = new ClassCounter(sourceDb, classCountsFileName);
      await classCounter.count();
      assert.isTrue(IModelJsFs.existsSync(classCountsFileName));
    }

    if (true) {
      // second import with no changes to source, should only update lastmod of elements
      Logger.logInfo(TransformerLoggerCategory.IModelTransformer, "");
      Logger.logInfo(
        TransformerLoggerCategory.IModelTransformer,
        "================="
      );
      Logger.logInfo(
        TransformerLoggerCategory.IModelTransformer,
        "Reimport (no-op)"
      );
      Logger.logInfo(
        TransformerLoggerCategory.IModelTransformer,
        "================="
      );
      const targetImporter = new RecordingIModelImporter(targetDb);
      const transformer = new TestIModelTransformer(sourceDb, targetImporter, {
        forceExternalSourceAspectProvenance: true,
      });
      await transformer.process();
      assert.equal(targetImporter.numModelsInserted, 0);
      assert.equal(targetImporter.numModelsUpdated, 0);
      assert.equal(targetImporter.numElementsInserted, 0);
      // TODO: explain which elements are updated
      assert.equal(targetImporter.numElementsUpdated, 38);
      assert.equal(targetImporter.numElementsExplicitlyDeleted, 0);
      assert.equal(targetImporter.numElementAspectsInserted, 0);
      assert.equal(targetImporter.numElementAspectsUpdated, 0);
      assert.equal(targetImporter.numRelationshipsInserted, 0);
      assert.equal(targetImporter.numRelationshipsUpdated, 0);
      assert.equal(targetImporter.numRelationshipsDeleted, 0);
      // assert.equal(numTargetElements, count(targetDb, Element.classFullName), "Second import should not add elements");
      assert.equal(
        numTargetExternalSourceAspects,
        count(targetDb, ExternalSourceAspect.classFullName),
        "Second import should not add aspects"
      );
      assert.equal(
        numTargetRelationships,
        count(targetDb, ElementRefersToElements.classFullName),
        "Second import should not add relationships"
      );
      assert.equal(
        3,
        count(sourceDb, "ExtensiveTestScenario:SourceInformationRecord")
      );
      assert.equal(
        3,
        count(targetDb, "ExtensiveTestScenarioTarget:TargetInformationRecord")
      );
      transformer.dispose();
    }

    if (true) {
      // update source db, then import again
      TransformerExtensiveTestScenario.updateDb(sourceDb);
      sourceDb.saveChanges();
      Logger.logInfo(TransformerLoggerCategory.IModelTransformer, "");
      Logger.logInfo(
        TransformerLoggerCategory.IModelTransformer,
        "==============================="
      );
      Logger.logInfo(
        TransformerLoggerCategory.IModelTransformer,
        "Reimport after sourceDb update"
      );
      Logger.logInfo(
        TransformerLoggerCategory.IModelTransformer,
        "==============================="
      );
      const targetImporter = new RecordingIModelImporter(targetDb);
      const transformer = new TestIModelTransformer(sourceDb, targetImporter, {
        forceExternalSourceAspectProvenance: true,
      });
      await transformer.process();
      assert.equal(targetImporter.numModelsInserted, 0);
      assert.equal(targetImporter.numModelsUpdated, 0);
      assert.equal(targetImporter.numElementsInserted, 1);
      assert.equal(targetImporter.numElementsUpdated, 33);
      /**
       * There are 5 elements deleted in TransformerExtensiveTestScenario.updateDb, but only 4 detected.
       * This is because PhysicalObject6's code is scoped to PhysicalObject5. When PhysicalObject5 is deleted, PhysicalObject6 is also deleted in the superclasses
       * of the RecordingIModelImporter and therefore can't be detected by the RecordingIModelImporter.
       * The deletion of PhysicalObject6 is asserted in [[TransformerExtensiveTestScenario.assertUpdatesInDb]] when assertDeletes is true.
       */
      assert.equal(targetImporter.numElementsExplicitlyDeleted, 4);
      assert.equal(targetImporter.numElementAspectsInserted, 0);
      assert.equal(targetImporter.numElementAspectsUpdated, 2);
      assert.equal(targetImporter.numRelationshipsInserted, 2);
      assert.equal(targetImporter.numRelationshipsUpdated, 1);

      assert.equal(targetImporter.numRelationshipsDeleted, 1);
      targetDb.saveChanges();
      TransformerExtensiveTestScenario.assertUpdatesInDb(targetDb, true);

      assert.equal(
        numTargetRelationships +
          targetImporter.numRelationshipsInserted -
          targetImporter.numRelationshipsDeleted,
        count(targetDb, ElementRefersToElements.classFullName)
      );
      // We deleted one of the 3 SourceInformationRecords in TransformerExtensiveTestScenario.updateDb, so expect to find 2 now.
      expect(
        count(targetDb, "ExtensiveTestScenarioTarget:TargetInformationRecord")
      ).to.equal(2);
      expect(
        count(sourceDb, "ExtensiveTestScenario:SourceInformationRecord")
      ).to.equal(2);
      transformer.dispose();
    }

    IModelTransformerTestUtils.dumpIModelInfo(sourceDb);
    IModelTransformerTestUtils.dumpIModelInfo(targetDb);
    sourceDb.close();
    targetDb.close();
  });

  it("should synchronize changes from master to branch and back", async () => {
    // Simulate branching workflow by initializing branchDb to be a copy of the populated masterDb
    const masterDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "Master.bim"
    );
    const masterDb = SnapshotDb.createFrom(
      await ReusedSnapshots.extensiveTestScenario,
      masterDbFile
    );
    const branchDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "Branch.bim"
    );
    const branchDb = SnapshotDb.createFrom(masterDb, branchDbFile, {
      createClassViews: true,
    });

    const numMasterElements = count(masterDb, Element.classFullName);
    const numMasterRelationships = count(
      masterDb,
      ElementRefersToElements.classFullName
    );
    assert.isAtLeast(numMasterElements, 12);
    assert.isAtLeast(numMasterRelationships, 1);
    assert.equal(numMasterElements, count(branchDb, Element.classFullName));
    assert.equal(
      numMasterRelationships,
      count(branchDb, ElementRefersToElements.classFullName)
    );
    assert.equal(0, count(branchDb, ExternalSourceAspect.classFullName));

    // Ensure that master to branch synchronization did not add any new Elements or Relationships, but did add ExternalSourceAspects
    const masterToBranchTransformer = new IModelTransformer(
      masterDb,
      branchDb,
      { wasSourceIModelCopiedToTarget: true }
    ); // Note use of `wasSourceIModelCopiedToTarget` flag
    await masterToBranchTransformer.process();
    masterToBranchTransformer.dispose();
    branchDb.saveChanges();
    assert.equal(numMasterElements, count(branchDb, Element.classFullName));
    assert.equal(
      numMasterRelationships,
      count(branchDb, ElementRefersToElements.classFullName)
    );
    assert.equal(count(branchDb, ExternalSourceAspect.classFullName), 1); // provenance aspect added for target scope element

    // Confirm that provenance (captured in ExternalSourceAspects) was set correctly
    const sql = `SELECT aspect.Identifier,aspect.Element.Id FROM ${ExternalSourceAspect.classFullName} aspect WHERE aspect.Kind=:kind`;
    branchDb.withPreparedStatement(sql, (statement: ECSqlStatement): void => {
      statement.bindString("kind", ExternalSourceAspect.Kind.Element);
      while (DbResult.BE_SQLITE_ROW === statement.step()) {
        const masterElementId = statement.getValue(0).getString(); // ExternalSourceAspect.Identifier is of type string
        const branchElementId = statement.getValue(1).getId();
        assert.equal(masterElementId, branchElementId);
      }
    });

    // Make changes to simulate working on the branch
    TransformerExtensiveTestScenario.updateDb(branchDb);
    TransformerExtensiveTestScenario.assertUpdatesInDb(branchDb);
    branchDb.saveChanges();

    const numBranchElements = count(branchDb, Element.classFullName);
    const numBranchRelationships = count(
      branchDb,
      ElementRefersToElements.classFullName
    );
    assert.notEqual(numBranchElements, numMasterElements);
    assert.notEqual(numBranchRelationships, numMasterRelationships);

    // Synchronize changes from branch back to master
    const branchToMasterTransformer = new IModelTransformer(
      branchDb,
      masterDb,
      { noProvenance: true }
    );
    await branchToMasterTransformer.process();
    branchToMasterTransformer.dispose();
    masterDb.saveChanges();
    TransformerExtensiveTestScenario.assertUpdatesInDb(masterDb, false);
    assert.equal(numBranchElements, count(masterDb, Element.classFullName) - 5); // processAll cannot detect deletes when isReverseSynchronization=true
    assert.equal(
      numBranchRelationships,
      count(masterDb, ElementRefersToElements.classFullName) - 1
    ); // processAll cannot detect deletes when isReverseSynchronization=true
    assert.equal(0, count(masterDb, ExternalSourceAspect.classFullName));

    masterDb.close();
    branchDb.close();
  });

  function count(iModelDb: IModelDb, classFullName: string): number {
    return iModelDb.withPreparedStatement(
      `SELECT COUNT(*) FROM ${classFullName}`,
      (statement: ECSqlStatement): number => {
        return DbResult.BE_SQLITE_ROW === statement.step()
          ? statement.getValue(0).getInteger()
          : 0;
      }
    );
  }

  it("should import everything below a Subject", async () => {
    // Source IModelDb
    const sourceDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "SourceImportSubject.bim"
    );
    const sourceDb = SnapshotDb.createFrom(
      await ReusedSnapshots.extensiveTestScenario,
      sourceDbFile
    );
    const sourceSubjectId = sourceDb.elements.queryElementIdByCode(
      Subject.createCode(sourceDb, IModel.rootSubjectId, "Subject")
    )!;
    assert.isTrue(Id64.isValidId64(sourceSubjectId));
    sourceDb.saveChanges();
    // Target IModelDb
    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "TargetImportSubject.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "TargetImportSubject" },
    });
    await TransformerExtensiveTestScenario.prepareTargetDb(targetDb);
    const targetSubjectId = Subject.insert(
      targetDb,
      IModel.rootSubjectId,
      "Target Subject",
      "Target Subject Description"
    );
    assert.isTrue(Id64.isValidId64(targetSubjectId));
    targetDb.saveChanges();
    // Import from beneath source Subject into target Subject
    const transformer = new TestIModelTransformer(sourceDb, targetDb);
    await transformer.processFonts();
    await transformer.processSubject(sourceSubjectId, targetSubjectId);
    await transformer.processRelationships(
      ElementRefersToElements.classFullName
    );
    transformer.dispose();
    targetDb.saveChanges();
    TransformerExtensiveTestScenario.assertTargetDbContents(
      sourceDb,
      targetDb,
      { targetSubjectName: "Target Subject" }
    );
    const targetSubject: Subject =
      targetDb.elements.getElement<Subject>(targetSubjectId);
    assert.equal(targetSubject.description, "Target Subject Description");
    // Close
    sourceDb.close();
    targetDb.close();
  });

  /** @note For debugging/testing purposes, you can use `it.only` and hard-code `sourceFileName` to test cloning of a particular iModel. */
  it("should clone test file", async () => {
    // open source iModel
    const sourceFileName = TestUtils.IModelTestUtils.resolveAssetFile(
      "CompatibilityTestSeed.bim"
    );
    const sourceDb = SnapshotDb.openFile(sourceFileName);
    const numSourceElements = count(sourceDb, Element.classFullName);
    assert.exists(sourceDb);
    assert.isAtLeast(numSourceElements, 12);
    // create target iModel
    const targetDbFile = path.join(
      KnownTestLocations.outputDir,
      "IModelTransformer",
      "Clone-Target.bim"
    );
    if (IModelJsFs.existsSync(targetDbFile)) {
      IModelJsFs.removeSync(targetDbFile);
    }
    const targetDbProps: CreateIModelProps = {
      rootSubject: {
        name: `Cloned target of ${
          sourceDb.elements.getRootSubject().code.value
        }`,
      },
      ecefLocation: sourceDb.ecefLocation,
    };
    const targetDb = SnapshotDb.createEmpty(targetDbFile, targetDbProps);
    assert.exists(targetDb);
    // import
    const transformer = new IModelTransformer(sourceDb, targetDb);
    await transformer.processSchemas();
    await transformer.process();
    transformer.dispose();
    const numTargetElements = count(targetDb, Element.classFullName);
    assert.isAtLeast(numTargetElements, numSourceElements);
    assert.deepEqual(sourceDb.ecefLocation, targetDb.ecefLocation);
    // clean up
    sourceDb.close();
    targetDb.close();
  });

  it("should include source provenance", async () => {
    // create source iModel
    const sourceDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "SourceProvenance.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "Source Provenance Test" },
    });
    const sourceRepositoryId = IModelTransformerTestUtils.insertRepositoryLink(
      sourceDb,
      "master.dgn",
      "https://test.bentley.com/folder/master.dgn",
      "DGN"
    );
    const sourceExternalSourceId =
      IModelTransformerTestUtils.insertExternalSource(
        sourceDb,
        sourceRepositoryId,
        "Default Model"
      );
    const sourceCategoryId = SpatialCategory.insert(
      sourceDb,
      IModel.dictionaryId,
      "SpatialCategory",
      { color: ColorDef.green.toJSON() }
    );
    const sourceModelId = PhysicalModel.insert(
      sourceDb,
      IModel.rootSubjectId,
      "Physical"
    );
    for (const x of [1, 2, 3]) {
      const physicalObjectProps: PhysicalElementProps = {
        classFullName: PhysicalObject.classFullName,
        model: sourceModelId,
        category: sourceCategoryId,
        code: Code.createEmpty(),
        userLabel: `PhysicalObject(${x})`,
        geom: IModelTransformerTestUtils.createBox(Point3d.create(1, 1, 1)),
        placement: Placement3d.fromJSON({ origin: { x }, angles: {} }),
      };
      const physicalObjectId =
        sourceDb.elements.insertElement(physicalObjectProps);
      const aspectProps: ExternalSourceAspectProps = {
        // simulate provenance from a Connector
        classFullName: ExternalSourceAspect.classFullName,
        element: {
          id: physicalObjectId,
          relClassName: ElementOwnsExternalSourceAspects.classFullName,
        },
        scope: { id: sourceExternalSourceId },
        source: { id: sourceExternalSourceId },
        identifier: `ID${x}`,
        kind: ExternalSourceAspect.Kind.Element,
      };
      sourceDb.elements.insertAspect(aspectProps);
    }
    sourceDb.saveChanges();

    // create target iModel
    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "SourceProvenance-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "Source Provenance Test (Target)" },
    });

    // clone
    const transformer = new IModelTransformer(sourceDb, targetDb, {
      includeSourceProvenance: true,
    });
    await transformer.process();
    targetDb.saveChanges();

    // verify target contents
    assert.equal(1, count(sourceDb, RepositoryLink.classFullName));
    const targetRepositoryId = targetDb.elements.queryElementIdByCode(
      LinkElement.createCode(targetDb, IModel.repositoryModelId, "master.dgn")
    )!;
    assert.isTrue(Id64.isValidId64(targetRepositoryId));
    const targetExternalSourceId = IModelTransformerTestUtils.queryByUserLabel(
      targetDb,
      "Default Model"
    );
    assert.isTrue(Id64.isValidId64(targetExternalSourceId));
    const targetCategoryId = targetDb.elements.queryElementIdByCode(
      SpatialCategory.createCode(
        targetDb,
        IModel.dictionaryId,
        "SpatialCategory"
      )
    )!;
    assert.isTrue(Id64.isValidId64(targetCategoryId));
    const targetPhysicalObjectIds = [
      IModelTransformerTestUtils.queryByUserLabel(
        targetDb,
        "PhysicalObject(1)"
      ),
      IModelTransformerTestUtils.queryByUserLabel(
        targetDb,
        "PhysicalObject(2)"
      ),
      IModelTransformerTestUtils.queryByUserLabel(
        targetDb,
        "PhysicalObject(3)"
      ),
    ];
    for (const targetPhysicalObjectId of targetPhysicalObjectIds) {
      assert.isTrue(Id64.isValidId64(targetPhysicalObjectId));
      const physicalObject = targetDb.elements.getElement<PhysicalObject>(
        targetPhysicalObjectId,
        PhysicalObject
      );
      assert.equal(physicalObject.category, targetCategoryId);
      const aspects = targetDb.elements.getAspects(
        targetPhysicalObjectId,
        ExternalSourceAspect.classFullName
      );
      assert.equal(1, aspects.length, "Expect original source provenance");
      for (const aspect of aspects) {
        const externalSourceAspect = aspect as ExternalSourceAspect;
        if (
          externalSourceAspect.scope?.id === transformer.targetScopeElementId
        ) {
          // provenance added by IModelTransformer
          assert.equal(
            externalSourceAspect.kind,
            ExternalSourceAspect.Kind.Element
          );
        } else {
          // provenance carried over from the source iModel
          assert.equal(externalSourceAspect.scope?.id, targetExternalSourceId);
          assert.equal(externalSourceAspect.source!.id, targetExternalSourceId);
          assert.isTrue(externalSourceAspect.identifier.startsWith("ID"));
          assert.isTrue(
            physicalObject.userLabel!.includes(
              externalSourceAspect.identifier[2]
            )
          );
          assert.equal(
            externalSourceAspect.kind,
            ExternalSourceAspect.Kind.Element
          );
        }
      }
    }

    // clean up
    transformer.dispose();
    sourceDb.close();
    targetDb.close();
  });

  it("should transform 3d elements in target iModel", async () => {
    // create source iModel
    const sourceDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "Transform3d-Source.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "Transform3d-Source" },
    });
    const categoryId: Id64String = SpatialCategory.insert(
      sourceDb,
      IModel.dictionaryId,
      "SpatialCategory",
      { color: ColorDef.green.toJSON() }
    );
    const sourceModelId: Id64String = PhysicalModel.insert(
      sourceDb,
      IModel.rootSubjectId,
      "Physical"
    );
    const xArray: number[] = [1, 3, 5, 7, 9];
    const yArray: number[] = [0, 2, 4, 6, 8];
    for (const x of xArray) {
      for (const y of yArray) {
        const physicalObjectProps1: PhysicalElementProps = {
          classFullName: PhysicalObject.classFullName,
          model: sourceModelId,
          category: categoryId,
          code: Code.createEmpty(),
          userLabel: `PhysicalObject(${x},${y})`,
          geom: IModelTransformerTestUtils.createBox(Point3d.create(1, 1, 1)),
          placement: Placement3d.fromJSON({ origin: { x, y }, angles: {} }),
        };
        sourceDb.elements.insertElement(physicalObjectProps1);
      }
    }
    const sourceModel: PhysicalModel =
      sourceDb.models.getModel<PhysicalModel>(sourceModelId);
    const sourceModelExtents: AxisAlignedBox3d = sourceModel.queryExtents();
    assert.deepEqual(sourceModelExtents, new Range3d(1, 0, 0, 10, 9, 1));
    // create target iModel
    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "Transform3d-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "Transform3d-Target" },
    });
    // transform
    const transform3d: Transform = Transform.createTranslation(
      new Point3d(100, 200)
    );
    const transformer = new IModelTransformer3d(
      sourceDb,
      targetDb,
      transform3d
    );
    await transformer.process();
    const targetModelId: Id64String =
      transformer.context.findTargetElementId(sourceModelId);
    const targetModel: PhysicalModel =
      targetDb.models.getModel<PhysicalModel>(targetModelId);
    const targetModelExtents: AxisAlignedBox3d = targetModel.queryExtents();
    assert.deepEqual(targetModelExtents, new Range3d(101, 200, 0, 110, 209, 1));
    assert.deepEqual(
      targetModelExtents,
      transform3d.multiplyRange(sourceModelExtents)
    );
    // clean up
    transformer.dispose();
    sourceDb.close();
    targetDb.close();
  });

  it("should combine models", async () => {
    const sourceDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "source-separate-models.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "Separate Models" },
    });
    const sourceCategoryId = SpatialCategory.insert(
      sourceDb,
      IModel.dictionaryId,
      "Category",
      {}
    );
    const sourceModelId1 = PhysicalModel.insert(
      sourceDb,
      IModel.rootSubjectId,
      "M1"
    );
    const sourceModelId2 = PhysicalModel.insert(
      sourceDb,
      IModel.rootSubjectId,
      "M2"
    );
    const elementProps11: PhysicalElementProps = {
      classFullName: PhysicalObject.classFullName,
      model: sourceModelId1,
      code: Code.createEmpty(),
      userLabel: "PhysicalObject-M1-E1",
      category: sourceCategoryId,
      geom: IModelTransformerTestUtils.createBox(new Point3d(1, 1, 1)),
      placement: Placement3d.fromJSON({ origin: { x: 1, y: 1 }, angles: {} }),
    };
    const sourceElementId11 = sourceDb.elements.insertElement(elementProps11);
    const elementProps21: PhysicalElementProps = {
      classFullName: PhysicalObject.classFullName,
      model: sourceModelId2,
      code: Code.createEmpty(),
      userLabel: "PhysicalObject-M2-E1",
      category: sourceCategoryId,
      geom: IModelTransformerTestUtils.createBox(new Point3d(2, 2, 2)),
      placement: Placement3d.fromJSON({ origin: { x: 2, y: 2 }, angles: {} }),
    };
    const sourceElementId21 = sourceDb.elements.insertElement(elementProps21);
    sourceDb.saveChanges();
    assert.equal(count(sourceDb, PhysicalPartition.classFullName), 2);
    assert.equal(count(sourceDb, PhysicalModel.classFullName), 2);
    assert.equal(count(sourceDb, PhysicalObject.classFullName), 2);

    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "target-combined-model.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "Combined Model" },
    });
    const targetModelId = PhysicalModel.insert(
      targetDb,
      IModel.rootSubjectId,
      "PhysicalModel-Combined"
    );

    const transformer = new PhysicalModelConsolidator(
      sourceDb,
      targetDb,
      targetModelId
    );
    await transformer.process();
    targetDb.saveChanges();

    const targetElement11 = targetDb.elements.getElement(
      transformer.context.findTargetElementId(sourceElementId11)
    );
    assert.equal(targetElement11.userLabel, "PhysicalObject-M1-E1");
    assert.equal(targetElement11.model, targetModelId);
    const targetElement21 = targetDb.elements.getElement(
      transformer.context.findTargetElementId(sourceElementId21)
    );
    assert.equal(targetElement21.userLabel, "PhysicalObject-M2-E1");
    assert.equal(targetElement21.model, targetModelId);
    const targetPartition = targetDb.elements.getElement(targetModelId);
    assert.equal(
      targetPartition.code.value,
      "PhysicalModel-Combined",
      "Original CodeValue should be retained"
    );
    assert.equal(count(targetDb, PhysicalPartition.classFullName), 1);
    assert.equal(count(targetDb, PhysicalModel.classFullName), 1);
    assert.equal(count(targetDb, PhysicalObject.classFullName), 2);

    transformer.dispose();
    sourceDb.close();
    targetDb.close();
  });

  it("should sync Team iModels into Shared", async () => {
    const iModelShared: SnapshotDb =
      IModelTransformerTestUtils.createSharedIModel(
        outputDir,
        ["A", "B"],
        "shared"
      );

    if (true) {
      const iModelA: SnapshotDb = IModelTransformerTestUtils.createTeamIModel(
        outputDir,
        "A",
        Point3d.create(0, 0, 0),
        ColorDef.green,
        "team"
      );
      IModelTransformerTestUtils.assertTeamIModelContents(iModelA, "A");
      const iModelExporterA = new IModelExporter(iModelA);
      iModelExporterA.excludeElement(
        iModelA.elements.queryElementIdByCode(
          Subject.createCode(iModelA, IModel.rootSubjectId, "Context")
        )!
      );
      const subjectId: Id64String = IModelTransformerTestUtils.querySubjectId(
        iModelShared,
        "A"
      );
      const transformerA2S = new IModelTransformer(
        iModelExporterA,
        iModelShared,
        {
          targetScopeElementId: subjectId,
          danglingReferencesBehavior: "ignore",
          skipPropagateChangesToRootElements: false,
        }
      );
      transformerA2S.context.remapElement(IModel.rootSubjectId, subjectId);
      await transformerA2S.process();
      transformerA2S.dispose();
      // Make sure some properties, for example, description, can persist
      const teamIModelA: Subject = iModelA.elements.getElement<Subject>(
        IModel.rootSubjectId
      );
      const sharedIModelA: Subject =
        iModelShared.elements.getElement<Subject>(subjectId);
      assert.equal(teamIModelA.description, sharedIModelA.description);
      IModelTransformerTestUtils.dumpIModelInfo(iModelA);
      iModelA.close();
      iModelShared.saveChanges("Imported A");
      IModelTransformerTestUtils.assertSharedIModelContents(iModelShared, [
        "A",
      ]);
    }

    if (true) {
      const iModelB: SnapshotDb = IModelTransformerTestUtils.createTeamIModel(
        outputDir,
        "B",
        Point3d.create(0, 10, 0),
        ColorDef.blue
      );
      IModelTransformerTestUtils.assertTeamIModelContents(iModelB, "B");
      const iModelExporterB = new IModelExporter(iModelB);
      iModelExporterB.excludeElement(
        iModelB.elements.queryElementIdByCode(
          Subject.createCode(iModelB, IModel.rootSubjectId, "Context")
        )!
      );
      const subjectId: Id64String = IModelTransformerTestUtils.querySubjectId(
        iModelShared,
        "B"
      );
      const transformerB2S = new IModelTransformer(
        iModelExporterB,
        iModelShared,
        {
          targetScopeElementId: subjectId,
          danglingReferencesBehavior: "ignore",
        }
      );
      transformerB2S.context.remapElement(IModel.rootSubjectId, subjectId);
      await transformerB2S.process();
      transformerB2S.dispose();
      IModelTransformerTestUtils.dumpIModelInfo(iModelB);
      iModelB.close();
      iModelShared.saveChanges("Imported B");
      IModelTransformerTestUtils.assertSharedIModelContents(iModelShared, [
        "A",
        "B",
      ]);
    }

    if (true) {
      const iModelConsolidated: SnapshotDb =
        IModelTransformerTestUtils.createConsolidatedIModel(
          outputDir,
          "Consolidated"
        );
      const transformerS2C = new IModelTransformer(
        iModelShared,
        iModelConsolidated
      );
      const subjectA: Id64String = IModelTransformerTestUtils.querySubjectId(
        iModelShared,
        "A"
      );
      const subjectB: Id64String = IModelTransformerTestUtils.querySubjectId(
        iModelShared,
        "B"
      );
      const definitionA: Id64String =
        IModelTransformerTestUtils.queryDefinitionPartitionId(
          iModelShared,
          subjectA,
          "A"
        );
      const definitionB: Id64String =
        IModelTransformerTestUtils.queryDefinitionPartitionId(
          iModelShared,
          subjectB,
          "B"
        );
      const definitionC: Id64String =
        IModelTransformerTestUtils.queryDefinitionPartitionId(
          iModelConsolidated,
          IModel.rootSubjectId,
          "Consolidated"
        );
      transformerS2C.context.remapElement(definitionA, definitionC);
      transformerS2C.context.remapElement(definitionB, definitionC);
      const physicalA: Id64String =
        IModelTransformerTestUtils.queryPhysicalPartitionId(
          iModelShared,
          subjectA,
          "A"
        );
      const physicalB: Id64String =
        IModelTransformerTestUtils.queryPhysicalPartitionId(
          iModelShared,
          subjectB,
          "B"
        );
      const physicalC: Id64String =
        IModelTransformerTestUtils.queryPhysicalPartitionId(
          iModelConsolidated,
          IModel.rootSubjectId,
          "Consolidated"
        );
      transformerS2C.context.remapElement(physicalA, physicalC);
      transformerS2C.context.remapElement(physicalB, physicalC);
      await transformerS2C.processModel(definitionA);
      await transformerS2C.processModel(definitionB);
      await transformerS2C.processModel(physicalA);
      await transformerS2C.processModel(physicalB);
      await transformerS2C.processRelationships(
        ElementRefersToElements.classFullName
      );
      transformerS2C.dispose();
      IModelTransformerTestUtils.assertConsolidatedIModelContents(
        iModelConsolidated,
        "Consolidated"
      );
      IModelTransformerTestUtils.dumpIModelInfo(iModelConsolidated);
      iModelConsolidated.close();
    }

    IModelTransformerTestUtils.dumpIModelInfo(iModelShared);
    iModelShared.close();
  });

  it("remap root subject to root subject", async () => {
    const sourceIModelFile: string =
      IModelTransformerTestUtils.prepareOutputFile(
        "IModelTransformer",
        "source.bim"
      );
    const targetIModelFile: string =
      IModelTransformerTestUtils.prepareOutputFile(
        "IModelTransformer",
        "target.bim"
      );
    const sourceIModelDb: SnapshotDb = SnapshotDb.createEmpty(
      sourceIModelFile,
      {
        rootSubject: { name: "rootSource" },
        createClassViews: true,
      }
    );
    const targetIModelDb: SnapshotDb = SnapshotDb.createEmpty(
      targetIModelFile,
      {
        rootSubject: { name: "rootTarget" },
        createClassViews: true,
      }
    );
    assert.exists(sourceIModelDb);
    assert.exists(targetIModelDb);

    const transformer = new IModelTransformer(sourceIModelDb, targetIModelDb);
    transformer.context.remapElement(
      IModel.rootSubjectId,
      IModel.rootSubjectId
    );
    await transformer.process();
    transformer.dispose();
    const sourceIModelSubject: Subject =
      sourceIModelDb.elements.getElement<Subject>(IModel.rootSubjectId);
    const targetIModelSubject: Subject =
      targetIModelDb.elements.getElement<Subject>(IModel.rootSubjectId);
    expect(sourceIModelSubject).to.have.property("parent").that.is.undefined;
    expect(sourceIModelSubject.code.scope).to.eq(IModel.rootSubjectId);
    // rootSubjectId's parent still doesn't exist after the clone
    expect(targetIModelSubject).to.have.property("parent").that.is.undefined;
    // the scope on its code is still itself.
    expect(targetIModelSubject.code.scope).to.eq(IModel.rootSubjectId);
    sourceIModelDb.close();
    targetIModelDb.close();
  });

  it("remap non-root subject to non-root subject", async () => {
    const sourceIModelFile: string =
      IModelTransformerTestUtils.prepareOutputFile(
        "IModelTransformer",
        "source.bim"
      );
    const targetIModelFile: string =
      IModelTransformerTestUtils.prepareOutputFile(
        "IModelTransformer",
        "target.bim"
      );
    const sourceIModelDb: SnapshotDb = SnapshotDb.createEmpty(
      sourceIModelFile,
      {
        rootSubject: { name: "rootSource" },
        createClassViews: true,
      }
    );
    const targetIModelDb: SnapshotDb = SnapshotDb.createEmpty(
      targetIModelFile,
      {
        rootSubject: { name: "rootTarget" },
        createClassViews: true,
      }
    );
    assert.exists(sourceIModelDb);
    assert.exists(targetIModelDb);

    const sourceSubjectId: Id64String = Subject.insert(
      sourceIModelDb,
      IModel.rootSubjectId,
      "source"
    );
    const targetSubjectId: Id64String = Subject.insert(
      targetIModelDb,
      IModel.rootSubjectId,
      "target"
    );
    const transformer = new IModelTransformer(sourceIModelDb, targetIModelDb);
    transformer.context.remapElement(sourceSubjectId, targetSubjectId);
    await transformer.process();
    transformer.dispose();
    const sourceIModelSubject: Subject =
      sourceIModelDb.elements.getElement<Subject>(sourceSubjectId);
    const targetIModelSubject: Subject =
      targetIModelDb.elements.getElement<Subject>(targetSubjectId);
    // ParentId of non root-subject == rootSubjectId
    expect(sourceIModelSubject.parent?.id).to.eq(IModel.rootSubjectId);
    expect(targetIModelSubject.parent?.id).to.eq(IModel.rootSubjectId);
    // rootSubjectId == scope on the code of non root-subject
    expect(sourceIModelSubject.code.scope).to.eq(IModel.rootSubjectId);
    expect(targetIModelSubject.code.scope).to.eq(IModel.rootSubjectId);
    // Remapping a non root-subject to a non root-subject keeps its parent and code as expected
    expect(sourceIModelSubject.parent).to.deep.eq(targetIModelSubject.parent);
    expect(sourceIModelSubject.code).to.deep.eq(targetIModelSubject.code);
    sourceIModelDb.close();
    targetIModelDb.close();
  });

  it("remap root subject to non-root subject", async () => {
    const sourceIModelFile: string =
      IModelTransformerTestUtils.prepareOutputFile(
        "IModelTransformer",
        "source.bim"
      );
    const targetIModelFile: string =
      IModelTransformerTestUtils.prepareOutputFile(
        "IModelTransformer",
        "target.bim"
      );
    const sourceIModelDb: SnapshotDb = SnapshotDb.createEmpty(
      sourceIModelFile,
      {
        rootSubject: { name: "rootSource" },
        createClassViews: true,
      }
    );
    const targetIModelDb: SnapshotDb = SnapshotDb.createEmpty(
      targetIModelFile,
      {
        rootSubject: { name: "rootTarget" },
        createClassViews: true,
      }
    );
    assert.exists(sourceIModelDb);
    assert.exists(targetIModelDb);
    const targetSubjectId: Id64String = Subject.insert(
      targetIModelDb,
      IModel.rootSubjectId,
      "target"
    );
    const transformer = new IModelTransformer(sourceIModelDb, targetIModelDb, {
      danglingReferencesBehavior: "ignore",
    });
    transformer.context.remapElement(IModel.rootSubjectId, targetSubjectId);
    await transformer.process();
    transformer.dispose();
    const targetIModelSubject: Subject =
      targetIModelDb.elements.getElement<Subject>(targetSubjectId);
    expect(targetIModelSubject.parent?.id).eq(IModel.rootSubjectId);
    expect(targetIModelSubject.code.scope).eq(IModel.rootSubjectId);
    sourceIModelDb.close();
    targetIModelDb.close();
  });

  it("remap root subject to non-root subject with non-root parent", async () => {
    const sourceIModelFile: string =
      IModelTransformerTestUtils.prepareOutputFile(
        "IModelTransformer",
        "source.bim"
      );
    const targetIModelFile: string =
      IModelTransformerTestUtils.prepareOutputFile(
        "IModelTransformer",
        "target.bim"
      );
    const sourceIModelDb: SnapshotDb = SnapshotDb.createEmpty(
      sourceIModelFile,
      {
        rootSubject: { name: "rootSource" },
        createClassViews: true,
      }
    );
    const targetIModelDb: SnapshotDb = SnapshotDb.createEmpty(
      targetIModelFile,
      {
        rootSubject: { name: "rootTarget" },
        createClassViews: true,
      }
    );
    assert.exists(sourceIModelDb);
    assert.exists(targetIModelDb);
    const targetParentSubjectId: Id64String = Subject.insert(
      targetIModelDb,
      IModel.rootSubjectId,
      "targetParent"
    );
    const targetChildSubjectId: Id64String = Subject.insert(
      targetIModelDb,
      targetParentSubjectId,
      "targetChild"
    );
    const transformer = new IModelTransformer(sourceIModelDb, targetIModelDb, {
      danglingReferencesBehavior: "ignore",
    });
    transformer.context.remapElement(
      IModel.rootSubjectId,
      targetChildSubjectId
    );
    await transformer.process();
    transformer.dispose();
    const targetChildIModelSubject: Subject =
      targetIModelDb.elements.getElement<Subject>(targetChildSubjectId);
    // child's parent should still be its original parent after remapping
    expect(targetChildIModelSubject.parent?.id).eq(targetParentSubjectId);
    // child's code scope should still be its parent after remapping
    expect(targetChildIModelSubject.code.scope).eq(targetParentSubjectId);
    sourceIModelDb.close();
    targetIModelDb.close();
  });

  it.skip("should log unresolved references", async () => {
    const iModelShared: SnapshotDb =
      IModelTransformerTestUtils.createSharedIModel(outputDir, ["A", "B"]);
    const iModelA: SnapshotDb = IModelTransformerTestUtils.createTeamIModel(
      outputDir,
      "A",
      Point3d.create(0, 0, 0),
      ColorDef.green
    );
    IModelTransformerTestUtils.assertTeamIModelContents(iModelA, "A");
    const iModelExporterA = new IModelExporter(iModelA);

    // Exclude element
    const excludedId = iModelA.elements.queryElementIdByCode(
      Subject.createCode(iModelA, IModel.rootSubjectId, "Context")
    );
    assert.isDefined(excludedId);
    iModelExporterA.excludeElement(excludedId!);

    const subjectId: Id64String = IModelTransformerTestUtils.querySubjectId(
      iModelShared,
      "A"
    );
    const transformerA2S = new IModelTransformer(
      iModelExporterA,
      iModelShared,
      { targetScopeElementId: subjectId, danglingReferencesBehavior: "ignore" }
    );
    transformerA2S.context.remapElement(IModel.rootSubjectId, subjectId);

    // Configure logger to capture warning message about unresolved references
    const messageStart = "The following elements were never fully resolved:\n";
    const messageEnd =
      "\nThis indicates that either some references were excluded from the transformation\nor the source has dangling references.";

    let unresolvedElementMessage: string | undefined;
    const logWarning = (
      _category: string,
      message: string,
      _metaData: LoggingMetaData
    ) => {
      if (message.startsWith(messageStart)) {
        unresolvedElementMessage = message;
      }
    };
    Logger.initialize(undefined, logWarning);
    Logger.setLevelDefault(LogLevel.Warning);

    // Act
    await transformerA2S.process();

    // Collect expected ids
    const result = iModelA.queryEntityIds({
      from: "BisCore.Element",
      where: "Model.Id = :rootId AND ECInstanceId NOT IN (:excludedId)",
      bindings: { rootId: IModel.rootSubjectId, excludedId },
    });
    const expectedIds = [...result].map((x) => `e${x}`);

    // Collect actual ids
    assert.isDefined(unresolvedElementMessage);
    const actualIds = unresolvedElementMessage!
      .split(messageStart)[1]
      .split(messageEnd)[0]
      .split(",");

    // Assert
    assert.equal(actualIds.length, 5);
    assert.sameMembers(actualIds, expectedIds);

    transformerA2S.dispose();
    iModelA.close();
    iModelShared.close();
  });

  it("should detect conflicting provenance scopes", async () => {
    const sourceDb1 = IModelTransformerTestUtils.createTeamIModel(
      outputDir,
      "S1",
      Point3d.create(0, 0, 0),
      ColorDef.green
    );
    const sourceDb2 = IModelTransformerTestUtils.createTeamIModel(
      outputDir,
      "S2",
      Point3d.create(0, 10, 0),
      ColorDef.blue
    );
    assert.notEqual(sourceDb1.iModelId, sourceDb2.iModelId); // iModelId must be different to detect provenance scope conflicts

    const targetDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "ConflictingScopes.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "Conflicting Scopes Test" },
    });

    const transformer1 = new IModelTransformer(sourceDb1, targetDb); // did not set targetScopeElementId
    const transformer2 = new IModelTransformer(sourceDb2, targetDb); // did not set targetScopeElementId

    await transformer1.process(); // first one succeeds using IModel.rootSubjectId as the default targetScopeElementId

    try {
      await transformer2.process(); // expect IModelError to be thrown because of the targetScopeElementId conflict with second transformation
      assert.fail("Expected provenance scope conflict");
    } catch (e) {
      assert.isTrue(e instanceof IModelError);
    } finally {
      transformer1.dispose();
      transformer2.dispose();
      sourceDb1.close();
      sourceDb2.close();
      targetDb.close();
    }
  });

  it("IModelElementCloneContext remap tests", async () => {
    const iModelDb: SnapshotDb = IModelTransformerTestUtils.createTeamIModel(
      outputDir,
      "Test",
      Point3d.create(0, 0, 0),
      ColorDef.green
    );
    const cloneContext = new IModelElementCloneContext(iModelDb);
    const sourceId: Id64String = Id64.fromLocalAndBriefcaseIds(1, 1);
    const targetId: Id64String = Id64.fromLocalAndBriefcaseIds(1, 2);
    cloneContext.remapElement(sourceId, targetId);
    assert.equal(targetId, cloneContext.findTargetElementId(sourceId));
    assert.equal(Id64.invalid, cloneContext.findTargetElementId(targetId));
    assert.equal(Id64.invalid, cloneContext.findTargetCodeSpecId(targetId));
    assert.throws(() =>
      cloneContext.remapCodeSpec("SourceNotFound", "TargetNotFound")
    );
    cloneContext.dispose();
    iModelDb.close();
  });

  it("should clone across schema versions", async () => {
    // NOTE: schema differences between 01.00.00 and 01.00.01 were crafted to reproduce a cloning bug. The goal of this test is to prevent regressions.
    const cloneTestSchema100 = TestUtils.IModelTestUtils.resolveAssetFile(
      "CloneTest.01.00.00.ecschema.xml"
    );
    const cloneTestSchema101 = TestUtils.IModelTestUtils.resolveAssetFile(
      "CloneTest.01.00.01.ecschema.xml"
    );

    const seedDb = SnapshotDb.openFile(
      TestUtils.IModelTestUtils.resolveAssetFile("CompatibilityTestSeed.bim")
    );
    const sourceDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "CloneWithSchemaChanges-Source.bim"
    );
    const sourceDb = SnapshotDb.createFrom(seedDb, sourceDbFile);
    await sourceDb.importSchemas([cloneTestSchema100]);
    const sourceElementProps = {
      classFullName: "CloneTest:PhysicalType",
      model: IModel.dictionaryId,
      code: PhysicalType.createCode(sourceDb, IModel.dictionaryId, "Type1"),
      string1: "a",
      string2: "b",
    };
    const sourceElementId = sourceDb.elements.insertElement(sourceElementProps);
    const sourceElement = sourceDb.elements.getElement(sourceElementId);
    assert.equal(sourceElement.asAny.string1, "a");
    assert.equal(sourceElement.asAny.string2, "b");
    sourceDb.saveChanges();

    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "CloneWithSchemaChanges-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "CloneWithSchemaChanges-Target" },
    });
    await targetDb.importSchemas([cloneTestSchema101]);

    const transformer = new IModelTransformer(sourceDb, targetDb);
    await transformer.processElement(sourceElementId);
    targetDb.saveChanges();

    const targetElementId =
      transformer.context.findTargetElementId(sourceElementId);
    const targetElement = targetDb.elements.getElement(targetElementId);
    assert.equal(targetElement.asAny.string1, "a");
    assert.equal(targetElement.asAny.string2, "b");

    seedDb.close();
    sourceDb.close();
    targetDb.close();
  });

  it("Should not visit elements or relationships", async () => {
    // class that asserts if it encounters an element or relationship
    class TestExporter extends IModelExportHandler {
      public iModelExporter: IModelExporter;
      public modelCount = 0;
      public constructor(iModelDb: IModelDb) {
        super();
        this.iModelExporter = new IModelExporter(iModelDb);
        this.iModelExporter.registerHandler(this);
      }
      public override onExportModel(
        _model: Model,
        _isUpdate: boolean | undefined
      ): void {
        ++this.modelCount;
      }
      public override onExportElement(
        _element: Element,
        _isUpdate: boolean | undefined
      ): void {
        assert.fail("Should not visit element when visitElements=false");
      }
      public override onExportRelationship(
        _relationship: Relationship,
        _isUpdate: boolean | undefined
      ): void {
        assert.fail(
          "Should not visit relationship when visitRelationship=false"
        );
      }
    }
    const sourceFileName = TestUtils.IModelTestUtils.resolveAssetFile(
      "CompatibilityTestSeed.bim"
    );
    const sourceDb: SnapshotDb = SnapshotDb.openFile(sourceFileName);
    const exporter = new TestExporter(sourceDb);
    exporter.iModelExporter.visitElements = false;
    exporter.iModelExporter.visitRelationships = false;
    // call various methods to make sure the onExport* callbacks don't assert
    await exporter.iModelExporter.exportAll();
    await exporter.iModelExporter.exportElement(IModel.rootSubjectId);
    await exporter.iModelExporter.exportChildElements(IModel.rootSubjectId);
    await exporter.iModelExporter.exportModelContents(IModel.repositoryModelId);
    await exporter.iModelExporter.exportRelationships(
      ElementRefersToElements.classFullName
    );
    // make sure the exporter actually visited something
    assert.isAtLeast(exporter.modelCount, 4);
    sourceDb.close();
  });

  it("Should filter by ViewDefinition", async () => {
    const sourceDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "FilterByView-Source.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "FilterByView-Source" },
    });
    const categoryNames: string[] = ["C1", "C2", "C3", "C4", "C5"];
    categoryNames.forEach((categoryName) => {
      const categoryId = SpatialCategory.insert(
        sourceDb,
        IModel.dictionaryId,
        categoryName,
        {}
      );
      CategorySelector.insert(sourceDb, IModel.dictionaryId, categoryName, [
        categoryId,
      ]);
    });
    const modelNames: string[] = ["MA", "MB", "MC", "MD"];
    modelNames.forEach((modelName) => {
      const modelId = PhysicalModel.insert(
        sourceDb,
        IModel.rootSubjectId,
        modelName
      );
      ModelSelector.insert(sourceDb, IModel.dictionaryId, modelName, [modelId]);
    });
    const projectExtents = new Range3d();
    const displayStyleId = DisplayStyle3d.insert(
      sourceDb,
      IModel.dictionaryId,
      "DisplayStyle"
    );
    for (let x = 0; x < categoryNames.length; x++) {
      // eslint-disable-line @typescript-eslint/prefer-for-of
      const categoryId = sourceDb.elements.queryElementIdByCode(
        SpatialCategory.createCode(
          sourceDb,
          IModel.dictionaryId,
          categoryNames[x]
        )
      )!;
      const categorySelectorId = sourceDb.elements.queryElementIdByCode(
        CategorySelector.createCode(
          sourceDb,
          IModel.dictionaryId,
          categoryNames[x]
        )
      )!;
      for (let y = 0; y < modelNames.length; y++) {
        // eslint-disable-line @typescript-eslint/prefer-for-of
        const modelId = sourceDb.elements.queryElementIdByCode(
          PhysicalPartition.createCode(
            sourceDb,
            IModel.rootSubjectId,
            modelNames[y]
          )
        )!;
        const modelSelectorId = sourceDb.elements.queryElementIdByCode(
          ModelSelector.createCode(sourceDb, IModel.dictionaryId, modelNames[y])
        )!;
        const physicalObjectProps: PhysicalElementProps = {
          classFullName: PhysicalObject.classFullName,
          model: modelId,
          category: categoryId,
          code: Code.createEmpty(),
          userLabel: `${PhysicalObject.className}-${categoryNames[x]}-${modelNames[y]}`,
          geom: IModelTransformerTestUtils.createBox(
            Point3d.create(1, 1, 1),
            categoryId
          ),
          placement: {
            origin: Point3d.create(x * 2, y * 2, 0),
            angles: YawPitchRollAngles.createDegrees(0, 0, 0),
          },
        };
        const physicalObjectId =
          sourceDb.elements.insertElement(physicalObjectProps);
        const physicalObject = sourceDb.elements.getElement<PhysicalObject>(
          physicalObjectId,
          PhysicalObject
        );
        const viewExtents = physicalObject.placement.calculateRange();
        OrthographicViewDefinition.insert(
          sourceDb,
          IModel.dictionaryId,
          `View-${categoryNames[x]}-${modelNames[y]}`,
          modelSelectorId,
          categorySelectorId,
          displayStyleId,
          viewExtents,
          StandardViewIndex.Iso
        );
        projectExtents.extendRange(viewExtents);
      }
    }
    sourceDb.updateProjectExtents(projectExtents);
    const exportCategorySelectorId = CategorySelector.insert(
      sourceDb,
      IModel.dictionaryId,
      "Export",
      [
        sourceDb.elements.queryElementIdByCode(
          SpatialCategory.createCode(
            sourceDb,
            IModel.dictionaryId,
            categoryNames[0]
          )
        )!,
        sourceDb.elements.queryElementIdByCode(
          SpatialCategory.createCode(
            sourceDb,
            IModel.dictionaryId,
            categoryNames[2]
          )
        )!,
        sourceDb.elements.queryElementIdByCode(
          SpatialCategory.createCode(
            sourceDb,
            IModel.dictionaryId,
            categoryNames[4]
          )
        )!,
      ]
    );
    const exportModelSelectorId = ModelSelector.insert(
      sourceDb,
      IModel.dictionaryId,
      "Export",
      [
        sourceDb.elements.queryElementIdByCode(
          PhysicalPartition.createCode(
            sourceDb,
            IModel.rootSubjectId,
            modelNames[1]
          )
        )!,
        sourceDb.elements.queryElementIdByCode(
          PhysicalPartition.createCode(
            sourceDb,
            IModel.rootSubjectId,
            modelNames[3]
          )
        )!,
      ]
    );
    const exportViewId = OrthographicViewDefinition.insert(
      sourceDb,
      IModel.dictionaryId,
      "Export",
      exportModelSelectorId,
      exportCategorySelectorId,
      displayStyleId,
      projectExtents,
      StandardViewIndex.Iso
    );
    sourceDb.saveChanges();

    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "FilterByView-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "FilterByView-Target" },
    });
    targetDb.updateProjectExtents(sourceDb.projectExtents);

    const transformer = new FilterByViewTransformer(
      sourceDb,
      targetDb,
      exportViewId
    );
    await transformer.processSchemas();
    await transformer.process();
    transformer.dispose();

    targetDb.saveChanges();
    targetDb.close();
    sourceDb.close();
  });

  it("processSchemas should handle out-of-order exported schemas", async () => {
    const testSchema1Path = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "TestSchema1.ecschema.xml"
    );
    IModelJsFs.writeFileSync(
      testSchema1Path,
      `<?xml version="1.0" encoding="UTF-8"?>
      <ECSchema schemaName="TestSchema1" alias="ts1" version="01.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1">
          <ECSchemaReference name="BisCore" version="01.00" alias="bis"/>
          <ECEntityClass typeName="TestElement1">
            <BaseClass>bis:PhysicalElement</BaseClass>
            <ECProperty propertyName="MyProp1" typeName="string"/>
          </ECEntityClass>
      </ECSchema>`
    );

    const testSchema2Path = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "TestSchema2.ecschema.xml"
    );
    IModelJsFs.writeFileSync(
      testSchema2Path,
      `<?xml version="1.0" encoding="UTF-8"?>
      <ECSchema schemaName="TestSchema2" alias="ts2" version="01.00.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.2">
          <ECSchemaReference name="BisCore" version="01.00.00" alias="bis"/>
          <ECSchemaReference name="TestSchema1" version="01.00.00" alias="ts1"/>
          <ECEntityClass typeName="TestElement2">
            <BaseClass>ts1:TestElement1</BaseClass>
            <ECProperty propertyName="MyProp2" typeName="string"/>
          </ECEntityClass>
      </ECSchema>`
    );

    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "OrderTestSource.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "Order Test" },
    });

    await sourceDb.importSchemas([testSchema1Path, testSchema2Path]);
    sourceDb.saveChanges();

    class OrderedExporter extends IModelExporter {
      public override async exportSchemas() {
        const schemaLoader = new SchemaLoader((name: string) =>
          this.sourceDb.getSchemaProps(name)
        );
        const schema1 = schemaLoader.getSchema("TestSchema1");
        const schema2 = schemaLoader.getSchema("TestSchema2");
        // by importing schema2 (which references schema1) first, we
        // prove that the import order in processSchemas does not matter
        await this.handler.onExportSchema(schema2);
        await this.handler.onExportSchema(schema1);
      }
    }

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "OrderTestTarget.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: { name: "Order Test" },
    });
    const transformer = new IModelTransformer(
      new OrderedExporter(sourceDb),
      targetDb
    );

    let error: any;
    try {
      await transformer.processSchemas();
    } catch (_error) {
      error = _error;
    }
    assert.isUndefined(error);

    targetDb.saveChanges();
    const targetImportedSchemasLoader = new SchemaLoader((name: string) =>
      targetDb.getSchemaProps(name)
    );
    const schema1InTarget =
      targetImportedSchemasLoader.getSchema("TestSchema1");
    assert.isDefined(schema1InTarget);
    const schema2InTarget =
      targetImportedSchemasLoader.getSchema("TestSchema2");
    assert.isDefined(schema2InTarget);

    sourceDb.close();
    targetDb.close();
  });

  it("processSchemas should wait for the schema import to finish to delete the export directory", async () => {
    const cloneTestSchema100 = TestUtils.IModelTestUtils.resolveAssetFile(
      "CloneTest.01.00.00.ecschema.xml"
    );
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "FinallyFirstTest.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "FinallyFirstTest" },
    });
    await sourceDb.importSchemas([cloneTestSchema100]);
    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "FinallyFirstTestOut.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: { name: "FinallyFirstTest" },
    });
    const transformer = new IModelTransformer(sourceDb, targetDb);

    const importSchemasResolved = sinon.spy();
    let importSchemasPromise: Promise<void>;

    sinon.replace(
      targetDb,
      "importSchemas",
      sinon.fake(async () => {
        importSchemasPromise = new Promise((resolve) =>
          setImmediate(() => {
            importSchemasResolved();
            resolve(undefined);
          })
        );
        return importSchemasPromise;
      })
    );

    const removeSyncSpy = sinon.spy(IModelJsFs, "removeSync");

    await transformer.processSchemas();
    assert(removeSyncSpy.calledAfter(importSchemasResolved));

    sinon.restore();
    sourceDb.close();
    targetDb.close();
  });

  it("handles definition element scoped by non-definitional element", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "BadReferencesExampleSource.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "BadReferenceExampleSource" },
    });

    // create a document partition in our iModel's root
    const documentListModelId = DocumentListModel.insert(
      sourceDb,
      IModelDb.rootSubjectId,
      "DocumentList"
    );

    // add a drawing to the document partition's model
    const drawingId = sourceDb.elements.insertElement({
      classFullName: Drawing.classFullName,
      model: documentListModelId,
      code: Drawing.createCode(sourceDb, documentListModelId, "Drawing"),
    });
    expect(Id64.isValidId64(drawingId)).to.be.true;

    // submodel our drawing with a DrawingModel
    const model = sourceDb.models.createModel({
      classFullName: DrawingModel.classFullName,
      modeledElement: { id: drawingId },
    });
    sourceDb.models.insertModel(model.toJSON());

    const myCodeSpecId = sourceDb.codeSpecs.insert(
      CodeSpec.create(sourceDb, "MyCodeSpec", CodeScopeSpec.Type.RelatedElement)
    );

    // insert a definition element which is scoped by a non-definition element (the drawing)
    const _physicalMaterialId = sourceDb.elements.insertElement({
      classFullName: GenericPhysicalMaterial.classFullName,
      model: IModel.dictionaryId,
      code: new Code({
        spec: myCodeSpecId,
        scope: drawingId,
        value: "physical material",
      }),
    } as DefinitionElementProps);

    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "BadReferenceExampleTarget.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: { name: sourceDb.rootSubject.name },
    });
    const transformer = new IModelTransformer(sourceDb, targetDb);

    await expect(transformer.processSchemas()).to.eventually.be.fulfilled;
    await expect(transformer.process()).to.eventually.be.fulfilled;

    // check if target imodel has the elements that source imodel had
    expect(targetDb.codeSpecs.hasName("MyCodeSpec")).to.be.true;
    const myCodeSpecIdTarget = targetDb.codeSpecs.getByName("MyCodeSpec").id;
    expect(myCodeSpecIdTarget).to.not.be.undefined;
    const drawingIdTarget = targetDb.elements.queryElementIdByCode(
      Drawing.createCode(targetDb, documentListModelId, "Drawing")
    ) as string;
    expect(Id64.isValidId64(drawingIdTarget)).to.be.true;
    const physicalMaterialIdTarget = targetDb.elements.queryElementIdByCode(
      new Code({
        spec: myCodeSpecIdTarget,
        scope: drawingIdTarget,
        value: "physical material",
      })
    );
    expect(physicalMaterialIdTarget).to.not.be.undefined;
    expect(Id64.isValidId64(physicalMaterialIdTarget as string)).to.be.true;

    sourceDb.close();
    targetDb.close();
  });

  it("handle backwards related-instance code in model", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "BadReferencesExampleSource.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "BadReferenceExampleSource" },
    });

    // create a document partition in our iModel's root
    const documentListModelId = DocumentListModel.insert(
      sourceDb,
      IModelDb.rootSubjectId,
      "DocumentList"
    );

    // add a drawing to the document partition's model
    const drawing1Id = sourceDb.elements.insertElement({
      classFullName: Drawing.classFullName,
      model: documentListModelId,
      code: Drawing.createCode(sourceDb, documentListModelId, "Drawing1"),
    });

    const drawing2Id = sourceDb.elements.insertElement({
      classFullName: Drawing.classFullName,
      model: documentListModelId,
      code: Drawing.createCode(sourceDb, documentListModelId, "Drawing2"),
    });

    const drawingModel1 = sourceDb.models.createModel({
      classFullName: DrawingModel.classFullName,
      modeledElement: { id: drawing1Id },
    });
    const drawingModel1Id = sourceDb.models.insertModel(drawingModel1.toJSON());

    const drawingModel2 = sourceDb.models.createModel({
      classFullName: DrawingModel.classFullName,
      modeledElement: { id: drawing2Id },
    });
    const drawingModel2Id = sourceDb.models.insertModel(drawingModel2.toJSON());

    const modelCodeSpec = sourceDb.codeSpecs.insert(
      CodeSpec.create(sourceDb, "ModelCodeSpec", CodeScopeSpec.Type.Model)
    );
    const relatedCodeSpecId = sourceDb.codeSpecs.insert(
      CodeSpec.create(
        sourceDb,
        "RelatedCodeSpec",
        CodeScopeSpec.Type.RelatedElement
      )
    );

    const categoryId = DrawingCategory.insert(
      sourceDb,
      IModel.dictionaryId,
      "DrawingCategory",
      { color: ColorDef.green.toJSON() }
    );

    // we make drawingGraphic2 in drawingModel2 first
    const drawingGraphic2Id = sourceDb.elements.insertElement({
      classFullName: DrawingGraphic.classFullName,
      model: drawingModel2Id,
      code: new Code({
        spec: modelCodeSpec,
        scope: drawingModel2Id,
        value: "drawing graphic 2",
      }),
      category: categoryId,
    } as GeometricElement2dProps);

    const _drawingGraphic1Id = sourceDb.elements.insertElement({
      classFullName: DrawingGraphic.classFullName,
      model: drawingModel1Id,
      code: new Code({
        spec: relatedCodeSpecId,
        scope: drawingGraphic2Id,
        value: "drawing graphic 1",
      }),
      category: categoryId,
    } as GeometricElement2dProps);

    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "BadReferenceExampleTarget.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: { name: sourceDb.rootSubject.name },
    });
    const transformer = new IModelTransformer(sourceDb, targetDb);

    await expect(transformer.processSchemas()).to.eventually.be.fulfilled;
    await expect(transformer.process()).to.eventually.be.fulfilled;

    // check if target imodel has the elements that source imodel had
    expect(targetDb.codeSpecs.hasName("ModelCodeSpec")).to.be.true;
    expect(targetDb.codeSpecs.hasName("RelatedCodeSpec")).to.be.true;
    const drawingIdTarget1 = targetDb.elements.queryElementIdByCode(
      Drawing.createCode(targetDb, documentListModelId, "Drawing1")
    );
    expect(drawingIdTarget1).to.not.be.undefined;
    expect(Id64.isValidId64(drawingIdTarget1 as string)).to.be.true;

    const drawingIdTarget2 = targetDb.elements.queryElementIdByCode(
      Drawing.createCode(targetDb, documentListModelId, "Drawing2")
    );
    expect(drawingIdTarget2).to.not.be.undefined;
    expect(Id64.isValidId64(drawingIdTarget2 as string)).to.be.true;

    const drawingGraphicIdTarget2Props =
      targetDb.elements.getElementProps(drawingGraphic2Id);
    expect(
      targetDb.elements.queryElementIdByCode(
        new Code(drawingGraphicIdTarget2Props.code)
      )
    ).to.not.be.undefined;
    expect(
      Id64.isValidId64(
        targetDb.elements.queryElementIdByCode(
          new Code(drawingGraphicIdTarget2Props.code)
        ) as string
      )
    ).to.be.true;

    const drawingGraphicIdTarget1Props =
      targetDb.elements.getElementProps(_drawingGraphic1Id);
    expect(
      targetDb.elements.queryElementIdByCode(
        new Code(drawingGraphicIdTarget1Props.code)
      )
    ).to.not.be.undefined;
    expect(
      Id64.isValidId64(
        targetDb.elements.queryElementIdByCode(
          new Code(drawingGraphicIdTarget1Props.code)
        ) as string
      )
    ).to.be.true;
    sourceDb.close();
    targetDb.close();
  });

  // for testing purposes only, based on SetToStandalone.ts, force a snapshot to mimic a standalone iModel
  function setToStandalone(iModelName: string) {
    // eslint-disable-next-line deprecation/deprecation
    const nativeDb = new IModelHost.platform.DgnDb();
    nativeDb.openIModel(iModelName, OpenMode.ReadWrite);
    nativeDb.setITwinId(Guid.empty); // empty iTwinId means "standalone"
    nativeDb.saveChanges(); // save change to iTwinId
    nativeDb.deleteAllTxns(); // necessary before resetting briefcaseId
    nativeDb.resetBriefcaseId(BriefcaseIdValue.Unassigned); // standalone iModels should always have BriefcaseId unassigned
    nativeDb.saveLocalValue("StandaloneEdit", JSON.stringify({ txns: true }));
    nativeDb.saveChanges(); // save change to briefcaseId
    nativeDb.closeFile();
  }

  it("biscore update is valid", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "BisCoreUpdateSource.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "BisCoreUpdate" },
    });

    // this seed has an old biscore, so we know that transforming an empty source (which starts with a fresh, updated biscore)
    // will cause an update to the old biscore in this target
    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "BisCoreUpdateTarget.bim"
    );
    const seedDb = SnapshotDb.openFile(
      TestUtils.IModelTestUtils.resolveAssetFile("CompatibilityTestSeed.bim")
    );
    const targetDbTestCopy = SnapshotDb.createFrom(seedDb, targetDbPath);
    targetDbTestCopy.close();
    seedDb.close();
    setToStandalone(targetDbPath);
    // StandaloneDb.upgradeStandaloneSchemas is the suggested method to handle a profile upgrade but that will also upgrade
    // the BisCore schema.  This test is explicitly testing that the BisCore schema will be updated from the source iModel
    const nativeDb = StandaloneDb.openDgnDb(
      { path: targetDbPath },
      OpenMode.ReadWrite,
      { profile: ProfileOptions.Upgrade, schemaLockHeld: true }
    );
    nativeDb.closeFile();
    const targetDb = StandaloneDb.openFile(targetDbPath);

    assert(
      Semver.lt(
        Schema.toSemverString(targetDb.querySchemaVersion("BisCore")!),
        Schema.toSemverString(sourceDb.querySchemaVersion("BisCore")!)
      ),
      "The targetDb must have a less up-to-date version of the BisCore schema than the source"
    );

    const transformer = new IModelTransformer(sourceDb, targetDb);
    await transformer.processSchemas();
    targetDb.saveChanges();

    assert(
      Semver.eq(
        Schema.toSemverString(targetDb.querySchemaVersion("BisCore")!),
        Schema.toSemverString(sourceDb.querySchemaVersion("BisCore")!)
      ),
      "The targetDb must now have an equivalent BisCore schema because it was updated"
    );

    sourceDb.close();
    targetDb.close();
  });

  /** gets a mapping of element ids to their content ignoring or removing variance that is expected when transforming */
  async function getAllElementsInvariants(
    db: IModelDb,
    filterPredicate?: (element: Element) => boolean
  ) {
    // The set of element Ids where the fed guid should be ignored (since it can change between transforms).
    const ignoreFedGuidElementIds = new Set<Id64String>([
      IModel.rootSubjectId,
      IModel.dictionaryId,
      "0xe", // id of realityDataSourcesModel
    ]);
    const result: Record<Id64String, any> = {};
    // eslint-disable-next-line deprecation/deprecation
    for await (const row of db.query("SELECT * FROM bis.Element", undefined, {
      rowFormat: QueryRowFormat.UseJsPropertyNames,
    })) {
      if (!filterPredicate || filterPredicate(db.elements.getElement(row.id))) {
        const { lastMod: _lastMod, ...invariantPortion } = row;
        if (ignoreFedGuidElementIds.has(row.id))
          delete invariantPortion.federationGuid;
        result[row.id] = invariantPortion;
      }
    }
    return result;
  }

  /** gets the ordered list of the relationships inserted earlier */
  async function getInvariantRelationsContent(
    db: IModelDb,
    filterPredicate?: (rel: { sourceId: string; targetId: string }) => boolean
  ): Promise<{ sourceId: Id64String; targetId: Id64String }[]> {
    const result = [];
    // eslint-disable-next-line deprecation/deprecation
    for await (const row of db.query(
      "SELECT * FROM bis.ElementRefersToElements",
      undefined,
      { rowFormat: QueryRowFormat.UseJsPropertyNames }
    )) {
      if (!filterPredicate || filterPredicate(row)) {
        const { id: _id, ...invariantPortion } = row;
        result.push(invariantPortion);
      }
    }
    return result;
  }

  it("preserveId option preserves element ids, not other entity ids", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdSource.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "PreserveId" },
    });

    const spatialCateg1Id = SpatialCategory.insert(
      sourceDb,
      IModelDb.dictionaryId,
      "spatial-category1",
      { color: ColorDef.blue.toJSON() }
    );
    const spatialCateg2Id = SpatialCategory.insert(
      sourceDb,
      IModelDb.dictionaryId,
      "spatial-category2",
      { color: ColorDef.red.toJSON() }
    );
    const myPhysModelId = PhysicalModel.insert(
      sourceDb,
      IModelDb.rootSubjectId,
      "myPhysicalModel"
    );
    const _physicalObjectIds = [
      spatialCateg1Id,
      spatialCateg2Id,
      spatialCateg2Id,
      spatialCateg2Id,
      spatialCateg2Id,
    ].map((categoryId, x) => {
      const physicalObjectProps: PhysicalElementProps = {
        classFullName: PhysicalObject.classFullName,
        model: myPhysModelId,
        category: categoryId,
        code: Code.createEmpty(),
        userLabel: `PhysicalObject(${x})`,
        geom: IModelTransformerTestUtils.createBox(Point3d.create(1, 1, 1)),
        placement: Placement3d.fromJSON({ origin: { x }, angles: {} }),
      };
      const physicalObjectId =
        sourceDb.elements.insertElement(physicalObjectProps);
      return physicalObjectId;
    });

    // these link table relationships (ElementRefersToElements > PartitionOriginatesFromRepository) are examples of non-element entities
    const physicalPartitions = new Array(3)
      .fill(null)
      .map((_, index) =>
        sourceDb.elements.insertElement({
          classFullName: PhysicalPartition.classFullName,
          model: IModelDb.rootSubjectId,
          parent: {
            id: IModelDb.rootSubjectId,
            relClassName: ElementOwnsChildElements.classFullName,
          },
          code: PhysicalPartition.createCode(
            sourceDb,
            IModelDb.rootSubjectId,
            `physical-partition-${index}`
          ),
        } as InformationPartitionElementProps)
      )
      .map((partitionId) => {
        const modelId = sourceDb.models.insertModel({
          classFullName: PhysicalModel.classFullName,
          modeledElement: { id: partitionId },
        } as ModelProps);
        return { modelId, partitionId }; // these are the same id because of submodeling
      });

    const linksIds = new Array(2).fill(null).map((_, index) => {
      const linkId = sourceDb.elements.insertElement({
        classFullName: RepositoryLink.classFullName,
        code: RepositoryLink.createCode(
          sourceDb,
          IModelDb.rootSubjectId,
          `repo-link-${index}`
        ),
        model: IModelDb.rootSubjectId,
        repositoryGuid: `2fd0e5ed-a4d7-40cd-be8a-57552f5736b${index}`, // random, doesn't matter, works for up to 10 of course
        format: "my-format",
      } as RepositoryLinkProps);
      return linkId;
    });

    const _nonElementEntityIds = [
      [physicalPartitions[1].partitionId, linksIds[0]],
      [physicalPartitions[1].partitionId, linksIds[1]],
      [physicalPartitions[2].partitionId, linksIds[0]],
      [physicalPartitions[2].partitionId, linksIds[1]],
    ].map(([sourceId, targetId]) =>
      sourceDb.relationships.insertInstance({
        classFullName: "BisCore:PartitionOriginatesFromRepository",
        sourceId,
        targetId,
      })
    );

    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdTarget.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: { name: "PreserveId" },
    });

    const spatialCateg2 =
      sourceDb.elements.getElement<SpatialCategory>(spatialCateg2Id);

    /** filter the category and all related elements from the source for transformation */
    function filterCategoryTransformationPredicate(elem: Element): boolean {
      // if we don't filter out the elements, the transformer will see that the category is a reference
      // and re-add it to the transformation.
      if (elem instanceof GeometricElement && elem.category === spatialCateg2Id)
        return false;
      if (elem.id === spatialCateg2Id) return false;
      return true;
    }

    /** filter the category and all related elements from the source for transformation */
    function filterRelationshipsToChangeIds({
      sourceId,
      targetId,
    }: {
      sourceId: Id64String;
      targetId: Id64String;
    }): boolean {
      // matches source+target of _nonElementEntityIds[0]
      if (
        sourceId === physicalPartitions[1].partitionId &&
        targetId === linksIds[0]
      )
        return false;
      return true;
    }

    /** filter the category and all related and child elements from the source for comparison, not transformation */
    function filterCategoryContentsPredicate(elem: Element): boolean {
      if (elem instanceof GeometricElement && elem.category === spatialCateg2Id)
        return false;
      if (elem.id === spatialCateg2Id) return false;
      if (elem.id === spatialCateg2.myDefaultSubCategoryId()) return false;
      return true;
    }

    class FilterCategoryTransformer extends IModelTransformer {
      public override shouldExportElement(elem: Element): boolean {
        if (!filterCategoryTransformationPredicate(elem)) return false;
        return super.shouldExportElement(elem);
      }
      public override shouldExportRelationship(rel: Relationship): boolean {
        if (!filterRelationshipsToChangeIds(rel)) return false;
        return super.shouldExportRelationship(rel);
      }
    }

    const transformer = new FilterCategoryTransformer(sourceDb, targetDb, {
      preserveElementIdsForFiltering: true,
    });
    await transformer.process();
    targetDb.saveChanges();

    const sourceContent = await getAllElementsInvariants(
      sourceDb,
      filterCategoryContentsPredicate
    );
    const targetContent = await getAllElementsInvariants(targetDb);
    expect(targetContent).to.deep.equal(sourceContent);

    const sourceRelations = await getInvariantRelationsContent(
      sourceDb,
      filterRelationshipsToChangeIds
    );
    const targetRelations = await getInvariantRelationsContent(targetDb);
    expect(sourceRelations).to.deep.equal(targetRelations);

    // now try inserting both an element and a relationship into the target to check the two entity id sequences are fine
    const spatialCateg3Id = SpatialCategory.insert(
      targetDb,
      IModelDb.dictionaryId,
      "spatial-category3",
      { color: ColorDef.black.toJSON() }
    );
    expect(Id64.isValid(spatialCateg3Id)).to.be.true;
    const spatialCateg3Subcateg1Id = SubCategory.insert(
      targetDb,
      spatialCateg3Id,
      "spatial-categ-subcateg-1",
      { color: ColorDef.white.toJSON() }
    );
    expect(Id64.isValid(spatialCateg3Subcateg1Id)).to.be.true;
    const insertedInstance = targetDb.relationships.insertInstance({
      classFullName: "BisCore:PartitionOriginatesFromRepository",
      sourceId: physicalPartitions[1].partitionId,
      targetId: linksIds[0],
    });
    expect(Id64.isValid(insertedInstance)).to.be.true;

    sourceDb.close();
    targetDb.close();
  });

  it("preserveId on test model", async () => {
    const seedDb = SnapshotDb.openFile(
      TestUtils.IModelTestUtils.resolveAssetFile("CompatibilityTestSeed.bim")
    );
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Source.bim"
    );
    // transforming the seed to an empty will update it to the latest bis from the new target
    // which minimizes differences we'd otherwise need to filter later
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: seedDb.rootSubject,
    });
    const seedTransformer = new IModelTransformer(seedDb, sourceDb);
    await seedTransformer.process();
    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });

    const transformer = new IModelTransformer(sourceDb, targetDb, {
      preserveElementIdsForFiltering: true,
    });
    await transformer.process();
    targetDb.saveChanges();

    const sourceContent = await getAllElementsInvariants(sourceDb);
    const targetContent = await getAllElementsInvariants(targetDb);
    expect(targetContent).to.deep.equal(sourceContent);

    sourceDb.close();
    targetDb.close();
  });

  function createIModelWithDanglingReference(opts: {
    name: string;
    path: string;
  }) {
    const sourceDb = SnapshotDb.createEmpty(opts.path, {
      rootSubject: { name: opts.name },
    });

    const sourceCategoryId = SpatialCategory.insert(
      sourceDb,
      IModel.dictionaryId,
      "SpatialCategory",
      { color: ColorDef.green.toJSON() }
    );
    const sourceModelId = PhysicalModel.insert(
      sourceDb,
      IModel.rootSubjectId,
      "Physical"
    );
    const myPhysObjCodeSpec = CodeSpec.create(
      sourceDb,
      "myPhysicalObjects",
      CodeScopeSpec.Type.ParentElement
    );
    const myPhysObjCodeSpecId = sourceDb.codeSpecs.insert(myPhysObjCodeSpec);
    const physicalObjects = [1, 2].map((x) => {
      const code = new Code({
        spec: myPhysObjCodeSpecId,
        scope: sourceModelId,
        value: `PhysicalObject(${x})`,
      });
      const props: PhysicalElementProps = {
        classFullName: PhysicalObject.classFullName,
        model: sourceModelId,
        category: sourceCategoryId,
        code,
        userLabel: `PhysicalObject(${x})`,
        geom: IModelTransformerTestUtils.createBox(Point3d.create(1, 1, 1)),
        placement: Placement3d.fromJSON({ origin: { x }, angles: {} }),
      };
      const id = sourceDb.elements.insertElement(props);
      return { code, id };
    });
    const displayStyleId = DisplayStyle3d.insert(
      sourceDb,
      IModel.dictionaryId,
      "MyDisplayStyle",
      {
        excludedElements: physicalObjects.map((o) => o.id),
      }
    );
    const displayStyleCode = sourceDb.elements.getElement(displayStyleId).code;

    const physObjId2 = physicalObjects[1].id;
    // this deletion makes the display style have an reference to a now-gone element
    sourceDb.elements.deleteElement(physObjId2);

    sourceDb.saveChanges();

    return [
      sourceDb,
      {
        sourceCategoryId,
        sourceModelId,
        physicalObjects,
        displayStyleId,
        displayStyleCode,
        myPhysObjCodeSpec,
      },
    ] as const;
  }

  function createEmptyTargetWithIdsStartingAfterSource(
    sourceDb: IModelDb,
    createTarget: () => StandaloneDb
  ): StandaloneDb {
    const nextId = (db: IModelDb) =>
      db.withSqliteStatement(
        "SELECT Val FROM be_Local WHERE Name='bis_elementidsequence'",
        (s) => [...s]
      )[0].val;
    sourceDb.saveChanges(); // save to make sure we get the latest id value
    const sourceNextId = nextId(sourceDb);
    const targetDb = createTarget();
    const pathName = targetDb.pathName;
    targetDb.withSqliteStatement(
      "UPDATE be_Local SET Val=? WHERE Name='bis_elementidsequence'",
      (s) => {
        s.bindInteger(1, sourceNextId + 1);
        assert(s.step() === DbResult.BE_SQLITE_DONE);
      }
    );
    targetDb.saveChanges();
    targetDb.close();
    return StandaloneDb.openFile(pathName);
  }

  /**
   * A transformer that resets the target's id sequence to ensure the target doesn't end up with the same ids as the source.
   * Useful if you need to check that some source/target element references match and want to be sure it isn't a coincidence.
   * @note it modifies the target so there are side effects
   */
  class ShiftedIdsEmptyTargetTransformer extends IModelTransformer {
    constructor(
      source: IModelDb,
      createTarget: () => StandaloneDb,
      options?: IModelTransformOptions
    ) {
      super(
        source,
        createEmptyTargetWithIdsStartingAfterSource(source, createTarget),
        options
      );
    }
  }

  /** combination of @see AssertOrderTransformer and @see ShiftedIdsEmptyTargetTransformer */
  class AssertOrderAndShiftIdsTransformer extends AssertOrderTransformer {
    constructor(
      order: Id64String[],
      source: IModelDb,
      createTarget: () => StandaloneDb,
      options?: IModelTransformOptions
    ) {
      super(
        order,
        source,
        createEmptyTargetWithIdsStartingAfterSource(source, createTarget),
        options
      );
    }
  }

  it("process() with preserveElementIdsForFiltering set to true should re-add deleted element with same id", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Source.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "iModelA" },
    });
    Subject.insert(sourceDb, IModel.rootSubjectId, "Subject1");
    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });

    // Execute process() so that elements from source are copied to target
    const transformer = new IModelTransformer(sourceDb, targetDb, {
      preserveElementIdsForFiltering: true,
    });
    await transformer.process();
    targetDb.saveChanges();

    let sourceContent = await getAllElementsInvariants(sourceDb);
    let targetContent = await getAllElementsInvariants(targetDb);
    expect(targetContent).to.deep.equal(sourceContent);

    // Delete subject 1 from target
    const code1 = Subject.createCode(
      targetDb,
      IModel.rootSubjectId,
      "Subject1"
    );
    const targetSubjectId1 = targetDb.elements.queryElementIdByCode(code1);
    expect(targetSubjectId1).to.not.be.undefined;
    targetDb.elements.deleteElement(targetSubjectId1!);
    targetDb.saveChanges();

    // Calling process() for second time with option to preserve elements in hopes of restoring deleted element
    const secondTransformer = new IModelTransformer(sourceDb, targetDb, {
      preserveElementIdsForFiltering: true,
    });
    await secondTransformer.process(); // should not throw error: duplicate code (65547) and should re-add deleted element
    targetDb.saveChanges();

    // verify that deleted element in target is added back - redundant check for explicitness
    const sourceElementJSON = sourceDb.elements
      .getElement<Subject>(targetSubjectId1!)
      .toJSON();
    const deletedElementInTargetJSON = targetDb.elements
      .getElement<Subject>(targetSubjectId1!)
      .toJSON();
    expect(sourceElementJSON).to.be.deep.equal(deletedElementInTargetJSON);

    sourceContent = await getAllElementsInvariants(sourceDb);
    targetContent = await getAllElementsInvariants(targetDb);
    expect(targetContent).to.deep.equal(sourceContent);

    sourceDb.close();
    targetDb.close();
  });

  it("process() with preserveElementIdsForFiltering set to true should update the element properties if element exists with desired id in target", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Source.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "iModelA" },
    });
    const sourceSubjectId = Subject.insert(
      sourceDb,
      IModel.rootSubjectId,
      "Subject1"
    );
    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });

    // Execute process() so that elements from source are copied to target
    const transformer = new IModelTransformer(sourceDb, targetDb, {
      preserveElementIdsForFiltering: true,
    });
    await transformer.process();
    targetDb.saveChanges();

    let sourceContent = await getAllElementsInvariants(sourceDb);
    let targetContent = await getAllElementsInvariants(targetDb);
    expect(targetContent).to.deep.equal(sourceContent);

    // update subject in source
    const sourceSubject =
      sourceDb.elements.getElement<Subject>(sourceSubjectId);
    const updatedDescription = "Subject1 Updated Description";
    sourceSubject.description = updatedDescription;
    sourceDb.elements.updateElement(sourceSubject.toJSON());
    sourceDb.saveChanges();

    // Calling process() for second time with option to preserve elements in hopes of updating element with desired id
    const secondTransformer = new IModelTransformer(sourceDb, targetDb, {
      preserveElementIdsForFiltering: true,
    });
    await secondTransformer.process(); // should update description for subject element
    targetDb.saveChanges();

    // target subject should have updated description
    const targetSubjectDescription =
      targetDb.elements.getElement<Subject>(sourceSubjectId).description;
    expect(targetSubjectDescription).to.equal(updatedDescription);

    sourceContent = await getAllElementsInvariants(sourceDb);
    targetContent = await getAllElementsInvariants(targetDb);
    expect(targetContent).to.deep.equal(sourceContent);

    sourceDb.close();
    targetDb.close();
  });

  it("process() with preserveElementIdsForFiltering set to true should not throw when called on 2 identical iModels", async () => {
    const seedDb = SnapshotDb.openFile(
      TestUtils.IModelTestUtils.resolveAssetFile("CompatibilityTestSeed.bim")
    );
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Source.bim"
    );
    // transforming the seed to an empty will update it to the latest bis from the new target
    // which minimizes differences we'd otherwise need to filter later
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: seedDb.rootSubject,
    });
    const seedTransformer = new IModelTransformer(seedDb, sourceDb);
    await seedTransformer.process();
    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });

    // Calling process() for first time will add all elements from source to target
    const transformer = new IModelTransformer(sourceDb, targetDb, {
      preserveElementIdsForFiltering: true,
    });
    await transformer.process();
    targetDb.saveChanges();

    // should not throw error: duplicate code (65547)
    const thirdTransformer = new IModelTransformer(sourceDb, targetDb, {
      preserveElementIdsForFiltering: true,
    });
    await thirdTransformer.process();
    targetDb.saveChanges();

    const sourceContent = await getAllElementsInvariants(sourceDb);
    const targetContent = await getAllElementsInvariants(targetDb);
    expect(targetContent).to.deep.equal(sourceContent);

    sourceDb.close();
    targetDb.close();
  });

  it("process() with preserveElementIdsForFiltering set to true should throw error if element exists but has different id in target", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Source.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "iModelA" },
    });
    Subject.insert(sourceDb, IModel.rootSubjectId, "Subject1");
    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });

    // Execute process() so that elements from source are copied to target
    const transformer = new IModelTransformer(sourceDb, targetDb, {
      preserveElementIdsForFiltering: true,
    });
    await transformer.process();
    targetDb.saveChanges();

    const sourceContent = await getAllElementsInvariants(sourceDb);
    const targetContent = await getAllElementsInvariants(targetDb);
    expect(targetContent).to.deep.equal(sourceContent);

    // Delete subject 1 from target
    const code = Subject.createCode(targetDb, IModel.rootSubjectId, "Subject1");
    const targetSubjectId = targetDb.elements.queryElementIdByCode(code);
    expect(targetSubjectId).to.not.be.undefined;

    targetDb.elements.deleteElement(targetSubjectId!);
    targetDb.saveChanges();

    // save subject 1 element properties for new subject(it should have same fed guid and code)
    const targetSubjectProps = sourceDb.elements.getElementProps(
      targetSubjectId!
    );
    targetSubjectProps.id = undefined;
    assert.isDefined(targetSubjectProps);

    // create new subject that is the same as subject 1 but has a different Id
    const newSubjectId = targetDb.elements.insertElement(targetSubjectProps);
    expect(newSubjectId).to.not.be.undefined;
    targetDb.saveChanges();

    // Calling process() for second time with option to preserve elements in hopes of throwing expected error
    const secondTransformer = new IModelTransformer(sourceDb, targetDb, {
      preserveElementIdsForFiltering: true,
    });

    await expect(secondTransformer.process()).to.be.rejectedWith(
      `Element id(${targetSubjectId}) cannot be preserved. Found a different mapping(${newSubjectId}) from source element`
    );

    sourceDb.close();
    targetDb.close();
  });

  it("process() with preserveElementIdsForFiltering set to true should throw error if an unrelated element in the target already uses id", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Source.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "iModelA" },
    });
    Subject.insert(sourceDb, IModel.rootSubjectId, "Subject1");
    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });

    // Execute process() so that elements from source are copied to target
    const transformer = new IModelTransformer(sourceDb, targetDb, {
      preserveElementIdsForFiltering: true,
    });
    await transformer.process();
    targetDb.saveChanges();

    const sourceContent = await getAllElementsInvariants(sourceDb);
    const targetContent = await getAllElementsInvariants(targetDb);
    expect(targetContent).to.deep.equal(sourceContent);

    // Delete subject 1 from target
    const code1 = Subject.createCode(
      targetDb,
      IModel.rootSubjectId,
      "Subject1"
    );
    const targetSubjectId1 = targetDb.elements.queryElementIdByCode(code1);
    expect(targetSubjectId1).to.not.be.undefined;

    targetDb.elements.deleteElement(targetSubjectId1!);
    targetDb.saveChanges();

    // save subject 1 element properties but only use the same id
    const newPropsForSubject3 = sourceDb.elements.getElementProps(
      targetSubjectId1!
    );
    newPropsForSubject3.federationGuid = undefined;
    const code3 = Subject.createCode(
      targetDb,
      IModel.rootSubjectId,
      "Subject3"
    );
    newPropsForSubject3.code = code3;

    // insert an unrelated element that uses same id as subject1
    // insertElement public api does not support forceUseId option
    // eslint-disable-next-line @itwin/no-internal, deprecation/deprecation
    const targetSubjectId3 = targetDb.nativeDb.insertElement(
      newPropsForSubject3,
      { forceUseId: true }
    );
    expect(targetSubjectId3).to.not.be.undefined;
    targetDb.saveChanges();

    // Calling process() for second time with option to preserve elements in hopes of of throwing expected error
    const secondTransformer = new IModelTransformer(sourceDb, targetDb, {
      preserveElementIdsForFiltering: true,
    });

    await expect(secondTransformer.process()).to.be.rejectedWith(
      `Element id(${targetSubjectId1}) cannot be preserved. An unrelated element in the target already uses id: ${targetSubjectId1}`
    );

    sourceDb.close();
    targetDb.close();
  });

  it("reference deletion is considered invalid when danglingReferencesBehavior='reject' and that is the default", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DanglingReferenceSource.bim"
    );
    const [sourceDb, { displayStyleId, physicalObjects }] =
      createIModelWithDanglingReference({
        name: "DanglingReferences",
        path: sourceDbPath,
      });

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DanglingReferenceTarget-reject.bim"
    );
    const targetDbForRejected = StandaloneDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });
    const targetDbForRejectedPath = targetDbForRejected.pathName;
    targetDbForRejected.close();

    const defaultTransformer = new ShiftedIdsEmptyTargetTransformer(
      sourceDb,
      () => StandaloneDb.openFile(targetDbForRejectedPath)
    );
    await expect(defaultTransformer.process()).to.be.rejectedWith(
      /Found a reference to an element "[^"]*" that doesn't exist/
    );
    defaultTransformer.targetDb.close();

    const rejectDanglingReferencesTransformer =
      new ShiftedIdsEmptyTargetTransformer(
        sourceDb,
        () => StandaloneDb.openFile(targetDbForRejectedPath),
        { danglingReferencesBehavior: "reject" }
      );
    await expect(
      rejectDanglingReferencesTransformer.process()
    ).to.be.rejectedWith(
      /Found a reference to an element "[^"]*" that doesn't exist/
    );
    defaultTransformer.targetDb.close();

    const runTransform = async (
      opts: Pick<IModelTransformOptions, "danglingReferencesBehavior">
    ) => {
      const thisTransformTargetPath =
        IModelTransformerTestUtils.prepareOutputFile(
          "IModelTransformer",
          `DanglingReferenceTarget-${opts.danglingReferencesBehavior}.bim`
        );
      const createTargetDb = () =>
        StandaloneDb.createEmpty(thisTransformTargetPath, {
          rootSubject: sourceDb.rootSubject,
        });
      const transformer = new ShiftedIdsEmptyTargetTransformer(
        sourceDb,
        createTargetDb,
        opts
      );
      await expect(transformer.process()).not.to.be.rejected;
      transformer.targetDb.saveChanges();

      expect(sourceDb.elements.tryGetElement(physicalObjects[1].id)).to.be
        .undefined;
      const displayStyleInSource =
        sourceDb.elements.getElement<DisplayStyle3d>(displayStyleId);
      expect([...displayStyleInSource.settings.excludedElementIds]).to.include(
        physicalObjects[1].id
      );

      const displayStyleInTargetId =
        transformer.context.findTargetElementId(displayStyleId);
      const displayStyleInTarget =
        transformer.targetDb.elements.getElement<DisplayStyle3d>(
          displayStyleInTargetId
        );

      const physObjsInTarget = physicalObjects.map((physObjInSource) => {
        const physObjInTargetId = transformer.context.findTargetElementId(
          physObjInSource.id
        );
        return { ...physObjInSource, id: physObjInTargetId };
      });

      expect(Id64.isValidId64(physObjsInTarget[0].id)).to.be.true;
      expect(Id64.isValidId64(physObjsInTarget[1].id)).not.to.be.true;

      return { displayStyleInTarget, physObjsInTarget };
    };

    const ignoreResult = await runTransform({
      danglingReferencesBehavior: "ignore",
    });

    expect([
      ...ignoreResult.displayStyleInTarget.settings.excludedElementIds,
    ]).to.deep.equal(
      ignoreResult.physObjsInTarget
        .filter(({ id }) => Id64.isValidId64(id))
        .map(({ id }) => id)
    );

    sourceDb.close();
    targetDbForRejected.close();
  });

  it("exports aspects of deferred elements", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DeferredElementWithAspects-Source.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "deferred-element-with-aspects" },
    });

    const testSchemaPath =
      IModelTransformerTestUtils.getPathToSchemaWithUniqueAspect();
    await sourceDb.importSchemas([testSchemaPath]);

    const myPhysicalModelId = PhysicalModel.insert(
      sourceDb,
      IModelDb.rootSubjectId,
      "MyPhysicalModel"
    );
    const mySpatialCategId = SpatialCategory.insert(
      sourceDb,
      IModelDb.dictionaryId,
      "MySpatialCateg",
      { color: ColorDef.black.toJSON() }
    );
    const myPhysicalObjId = sourceDb.elements.insertElement({
      classFullName: PhysicalObject.classFullName,
      model: myPhysicalModelId,
      category: mySpatialCategId,
      code: Code.createEmpty(),
      userLabel: "MyPhysicalObject",
      geom: IModelTransformerTestUtils.createBox(Point3d.create(1, 1, 1)),
      placement: Placement3d.fromJSON({ origin: { x: 1 }, angles: {} }),
    } as PhysicalElementProps);
    // because they are definition elements, display styles will be transformed first
    const myDisplayStyleId = DisplayStyle3d.insert(
      sourceDb,
      IModelDb.dictionaryId,
      "MyDisplayStyle3d",
      {
        excludedElements: [myPhysicalObjId],
      }
    );
    const sourceRepositoryId = IModelTransformerTestUtils.insertRepositoryLink(
      sourceDb,
      "external.repo",
      "https://external.example.com/folder/external.repo",
      "TEST"
    );
    const sourceExternalSourceId =
      IModelTransformerTestUtils.insertExternalSource(
        sourceDb,
        sourceRepositoryId,
        "HypotheticalDisplayConfigurer"
      );
    // simulate provenance from a connector as an example of a copied over element multi aspect
    const multiAspectProps: ExternalSourceAspectProps = {
      classFullName: ExternalSourceAspect.classFullName,
      element: {
        id: myDisplayStyleId,
        relClassName: ElementOwnsExternalSourceAspects.classFullName,
      },
      scope: { id: sourceExternalSourceId },
      source: { id: sourceExternalSourceId },
      identifier: "ID",
      kind: ExternalSourceAspect.Kind.Element,
    };
    sourceDb.elements.insertAspect(multiAspectProps);
    const uniqueAspectProps = {
      classFullName: "TestSchema1:MyUniqueAspect",
      element: {
        id: myDisplayStyleId,
        relClassName: ElementOwnsUniqueAspect.classFullName,
      },
      // eslint-disable-next-line @typescript-eslint/naming-convention
      myProp1: "prop_value",
    };
    sourceDb.elements.insertAspect(uniqueAspectProps);
    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "PreserveIdOnTestModel-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });

    const transformer = new IModelTransformer(sourceDb, targetDb, {
      includeSourceProvenance: true,
      noProvenance: true, // don't add transformer provenance aspects, makes querying for aspects later simpler
    });

    await transformer.processSchemas();
    await transformer.process();

    targetDb.saveChanges();

    const targetExternalSourceAspects = new Array<any>();
    const targetMyUniqueAspects = new Array<any>();
    targetDb.withStatement("SELECT * FROM bis.ExternalSourceAspect", (stmt) =>
      targetExternalSourceAspects.push(...stmt)
    );
    targetDb.withStatement("SELECT * FROM TestSchema1.MyUniqueAspect", (stmt) =>
      targetMyUniqueAspects.push(...stmt)
    );

    expect(targetMyUniqueAspects).to.have.lengthOf(1);
    expect(targetMyUniqueAspects[0].myProp1).to.equal(
      uniqueAspectProps.myProp1
    );
    expect(targetExternalSourceAspects).to.have.lengthOf(1);
    expect(targetExternalSourceAspects[0].identifier).to.equal(
      multiAspectProps.identifier
    );

    sinon.restore();
    sourceDb.close();
    targetDb.close();
  });

  it("IModelTransformer processes nav property references even in generated classes", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "GeneratedNavPropReferences-Source.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "GeneratedNavPropReferences" },
    });

    const testSchema1Path = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "TestSchema1.ecschema.xml"
    );
    IModelJsFs.writeFileSync(
      testSchema1Path,
      `<?xml version="1.0" encoding="UTF-8"?>
      <ECSchema schemaName="TestGeneratedClasses" alias="tgc" version="1.0.0" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1">
        <ECSchemaReference name="BisCore" version="01.00" alias="bis"/>
        <ECEntityClass typeName="TestEntity" description="a sample entity for the end of the test relationships">
          <BaseClass>bis:DefinitionElement</BaseClass>
          <ECProperty propertyName="prop" typeName="string" description="a sample property"/>
        </ECEntityClass>
        <ECRelationshipClass typeName="ElemRel" strength="referencing" description="elem rel 1" modifier="sealed">
          <Source multiplicity="(0..*)" roleLabel="refers to" polymorphic="false">
            <Class class="TestElementWithNavProp"/>
          </Source>
          <Target multiplicity="(0..1)" roleLabel="is referenced by" polymorphic="false">
            <Class class="TestEntity"/>
          </Target>
        </ECRelationshipClass>
        <ECEntityClass typeName="TestElementWithNavProp">
          <BaseClass>bis:DefinitionElement</BaseClass>
          <ECNavigationProperty propertyName="navProp" relationshipName="ElemRel" direction="Forward" />
        </ECEntityClass>
      </ECSchema>`
    );

    await sourceDb.importSchemas([testSchema1Path]);

    const navPropTargetId = sourceDb.elements.insertElement({
      classFullName: "TestGeneratedClasses:TestEntity",
      prop: "sample-value",
      model: IModelDb.dictionaryId,
      code: Code.createEmpty(),
    } as ElementProps);

    const elemWithNavPropId = sourceDb.elements.insertElement({
      classFullName: "TestGeneratedClasses:TestElementWithNavProp",
      navProp: {
        id: navPropTargetId,
        relClassName: "TestGeneratedClasses:ElemRel",
      },
      model: IModelDb.dictionaryId,
      code: Code.createEmpty(),
    } as ElementProps);

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "GeneratedNavPropReferences-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });

    class ProcessTargetLastTransformer extends IModelTransformer {
      public constructor(
        source: IModelDb,
        target: IModelDb,
        opts?: IModelTransformOptions
      ) {
        super(
          new (class extends IModelExporter {
            public override async exportElement(elementId: string) {
              if (elementId === navPropTargetId) {
                // don't export it, we'll export it later, after the holder
              } else if (elementId === elemWithNavPropId) {
                await super.exportElement(elemWithNavPropId);
                await super.exportElement(navPropTargetId);
              } else {
                await super.exportElement(elementId);
              }
            }
          })(source),
          target,
          opts
        );
      }
    }

    const transformer = new ProcessTargetLastTransformer(sourceDb, targetDb);
    await transformer.processSchemas();
    await transformer.process();

    targetDb.saveChanges();

    function getNavPropContent(db: IModelDb) {
      let results = new Array<{ id: Id64String; navProp: RelatedElement }>();
      db.withPreparedStatement(
        "SELECT ECInstanceId, navProp FROM TestGeneratedClasses.TestElementWithNavProp",
        (stmt) => {
          results = [...stmt];
        }
      );
      return results;
    }

    for (const navPropHolderInSource of getNavPropContent(sourceDb)) {
      const navPropHolderInTargetId = transformer.context.findTargetElementId(
        navPropHolderInSource.id
      );
      const navPropHolderInTarget = targetDb.elements.getElement(
        navPropHolderInTargetId
      );
      const navPropTargetInTarget = transformer.context.findTargetElementId(
        navPropHolderInSource.navProp.id
      );
      // cast to any to access untyped instance properties
      expect((navPropHolderInTarget as any)?.navProp?.id).to.equal(
        navPropTargetInTarget
      );
      expect((navPropHolderInTarget as any)?.navProp?.id).not.to.equal(
        Id64.invalid
      );
      expect((navPropHolderInTarget as any)?.navProp?.id).not.to.be.undefined;
    }

    expect(getNavPropContent(sourceDb)).to.have.length(1);
    expect(getNavPropContent(targetDb)).to.have.length(1);

    sourceDb.close();
    targetDb.close();
  });

  it("exhaustive identity transform", async () => {
    const seedDb = SnapshotDb.openFile(
      TestUtils.IModelTestUtils.resolveAssetFile("CompatibilityTestSeed.bim")
    );
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "ExhaustiveIdentityTransformSource.bim"
    );
    const sourceDb = SnapshotDb.createFrom(seedDb, sourceDbPath);

    // previously there was a bug where json display properties of models would not be transformed. This should expose that
    const [physicalModelId] = sourceDb.queryEntityIds({
      from: "BisCore.PhysicalModel",
      limit: 1,
    });
    const physicalModel = sourceDb.models.getModel(physicalModelId);
    physicalModel.jsonProperties.formatter.fmtFlags.linPrec = 100;
    physicalModel.update();

    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "ExhaustiveIdentityTransformTarget.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });

    const transformer = new IModelTransformer(sourceDb, targetDb);
    await transformer.processSchemas();
    await transformer.process();

    targetDb.saveChanges();

    await assertIdentityTransformation(sourceDb, targetDb, transformer, {
      compareElemGeom: true,
    });

    const physicalModelInTargetId =
      transformer.context.findTargetElementId(physicalModelId);
    const physicalModelInTarget = targetDb.models.getModel(
      physicalModelInTargetId
    );
    expect(
      physicalModelInTarget.jsonProperties.formatter.fmtFlags.linPrec
    ).to.equal(100);

    sourceDb.close();
    targetDb.close();
  });

  it("deferred element relationships get exported", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DeferredElementWithRelationships-Source.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "deferred-element-with-relationships" },
    });

    const testSchema1Path = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "TestSchema1.ecschema.xml"
    );
    // the only two ElementUniqueAspect's in bis are ignored by the transformer, so we add our own to test their export
    IModelJsFs.writeFileSync(
      testSchema1Path,
      `<?xml version="1.0" encoding="UTF-8"?>
      <ECSchema schemaName="TestSchema1" alias="ts1" version="01.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1">
        <ECSchemaReference name="BisCore" version="01.00" alias="bis"/>
        <ECRelationshipClass typeName="MyElemRefersToElem" strength="referencing" modifier="None">
          <BaseClass>bis:ElementRefersToElements</BaseClass>
          <ECProperty propertyName="prop" typeName="string" description="a sample property"/>
          <Source multiplicity="(0..*)" roleLabel="refers to" polymorphic="true">
            <Class class="bis:Element"/>
          </Source>
          <Target multiplicity="(0..*)" roleLabel="is referenced by" polymorphic="true">
            <Class class="bis:Element"/>
          </Target>
        </ECRelationshipClass>
      </ECSchema>`
    );

    await sourceDb.importSchemas([testSchema1Path]);

    const myPhysicalModelId = PhysicalModel.insert(
      sourceDb,
      IModelDb.rootSubjectId,
      "MyPhysicalModel"
    );
    const mySpatialCategId = SpatialCategory.insert(
      sourceDb,
      IModelDb.dictionaryId,
      "MySpatialCateg",
      { color: ColorDef.black.toJSON() }
    );
    const myPhysicalObjId = sourceDb.elements.insertElement({
      classFullName: PhysicalObject.classFullName,
      model: myPhysicalModelId,
      category: mySpatialCategId,
      code: Code.createEmpty(),
      userLabel: "MyPhysicalObject",
      geom: IModelTransformerTestUtils.createBox(Point3d.create(1, 1, 1)),
      placement: Placement3d.fromJSON({ origin: { x: 1 }, angles: {} }),
    } as PhysicalElementProps);
    // because they are definition elements, display styles will be transformed first
    const myDisplayStyleId = DisplayStyle3d.insert(
      sourceDb,
      IModelDb.dictionaryId,
      "MyDisplayStyle3d",
      {
        excludedElements: [myPhysicalObjId],
      }
    );
    const relProps = {
      sourceId: myDisplayStyleId,
      targetId: myPhysicalObjId,
      classFullName: "TestSchema1:MyElemRefersToElem",
      prop: "prop",
    };
    const _relInstId = sourceDb.relationships.insertInstance(
      relProps as RelationshipProps
    );

    sourceDb.saveChanges();
    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DeferredElementWithRelationships-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });

    const transformer = new IModelTransformer(sourceDb, targetDb);

    await transformer.processSchemas();
    await transformer.process();

    targetDb.saveChanges();

    const targetRelationships = new Array<any>();
    targetDb.withStatement("SELECT * FROM ts1.MyElemRefersToElem", (stmt) =>
      targetRelationships.push(...stmt)
    );

    expect(targetRelationships).to.have.lengthOf(1);
    expect(targetRelationships[0].prop).to.equal(relProps.prop);

    sinon.restore();
    sourceDb.close();
    targetDb.close();
  });

  for (const skipPropagateChangesToRootElements of [true, undefined, false]) {
    it(`should ${
      skipPropagateChangesToRootElements === false ? "update" : "not update"
    } root elements when skipPropagateChangesToRootElements is set to ${skipPropagateChangesToRootElements}`, async () => {
      const iModelShared: SnapshotDb =
        IModelTransformerTestUtils.createSharedIModel(outputDir, ["A", "B"]);
      const iModelA: SnapshotDb = IModelTransformerTestUtils.createTeamIModel(
        outputDir,
        "A",
        Point3d.create(0, 0, 0),
        ColorDef.green
      );
      IModelTransformerTestUtils.assertTeamIModelContents(iModelA, "A");
      const iModelExporterA = new IModelExporter(iModelA);

      const subjectId: Id64String = IModelTransformerTestUtils.querySubjectId(
        iModelShared,
        "A"
      );
      const transformerA2S = new IModelTransformer(
        iModelExporterA,
        iModelShared,
        {
          targetScopeElementId: subjectId,
          danglingReferencesBehavior: "ignore",
          skipPropagateChangesToRootElements,
        }
      );
      transformerA2S.context.remapElement(IModel.rootSubjectId, subjectId);
      // Act
      await transformerA2S.process();
      // Assert
      const rootElements = ["0x10", "0xe"];
      rootElements.forEach((rootElementId) => {
        const rootElement = iModelShared.elements.getElement(rootElementId);
        if (
          skipPropagateChangesToRootElements === undefined ||
          skipPropagateChangesToRootElements === true
        ) {
          assert.equal(
            rootElement.parent?.id,
            "0x1",
            `Root element '${rootElementId}' parent should not be remapped to '${rootElement.parent?.id}'.`
          );
        } else {
          assert.equal(
            rootElement.parent?.id,
            subjectId,
            `Root element '${rootElementId}' parent should be remapped to '${rootElement.parent?.id}'.`
          );
        }
      });

      transformerA2S.dispose();
      iModelA.close();
      iModelShared.close();
    });
  }

  it("IModelTransformer handles generated class nav property cycle", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "NavPropCycleSource.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "GeneratedNavPropReferences" },
    });

    const testSchema1Path = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "TestSchema1.ecschema.xml"
    );
    IModelJsFs.writeFileSync(
      testSchema1Path,
      `<?xml version="1.0" encoding="UTF-8"?>
      <ECSchema schemaName="TestSchema" alias="ts" version="1.0.0" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1">
        <ECSchemaReference name="BisCore" version="01.00" alias="bis"/>
        <ECEntityClass typeName="A" description="an A">
          <BaseClass>bis:DefinitionElement</BaseClass>
          <ECNavigationProperty propertyName="anotherA" relationshipName="AtoA" direction="Forward" displayLabel="Horizontal Alignment" />
        </ECEntityClass>
        <ECRelationshipClass typeName="AtoA" strength="referencing" description="a to a" modifier="sealed">
          <Source multiplicity="(0..*)" roleLabel="refers to" polymorphic="false">
            <Class class="A"/>
          </Source>
          <Target multiplicity="(0..1)" roleLabel="is referenced by" polymorphic="false">
            <Class class="A"/>
          </Target>
        </ECRelationshipClass>
      </ECSchema>`
    );

    await sourceDb.importSchemas([testSchema1Path]);

    const a1Id = sourceDb.elements.insertElement({
      classFullName: "TestSchema:A",
      // will be updated later to include this
      // anotherA: { id: a3Id, relClassName: "TestSchema:AtoA", },
      model: IModelDb.dictionaryId,
      code: Code.createEmpty(),
    } as ElementProps);

    const a2Id = sourceDb.elements.insertElement({
      classFullName: "TestSchema:A",
      anotherA: { id: a1Id, relClassName: "TestSchema:AtoA" },
      model: IModelDb.dictionaryId,
      code: Code.createEmpty(),
    } as ElementProps);

    sourceDb.elements.updateElement({
      id: a1Id,
      anotherA: { id: a2Id, relClassName: "TestSchema:AtoA" },
    } as any);

    const a4Id = sourceDb.elements.insertElement({
      classFullName: "TestSchema:A",
      // will be updated later to include this
      // anotherA: { id: a4Id, relClassName: "TestSchema:AtoA", },
      model: IModelDb.dictionaryId,
      code: Code.createEmpty(),
    } as ElementProps);

    sourceDb.elements.updateElement({
      id: a4Id,
      anotherA: { id: a4Id, relClassName: "TestSchema:AtoA" },
    } as any);

    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "NavPropCycleTarget.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });

    const transformer = new IModelTransformer(sourceDb, targetDb);
    await transformer.processSchemas();
    await transformer.process();

    targetDb.saveChanges();

    await assertIdentityTransformation(sourceDb, targetDb, transformer);

    sourceDb.close();
    targetDb.close();
  });

  it("handle out-of-order references in aspects during consolidations", async () => {
    const sourceDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "AspectCyclicRefs.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbPath, {
      rootSubject: { name: "aspect-cyclic-refs" },
    });

    // as a member of the repository model hierarchy, and not the root subject hierarchy, it will be exported after the element which is inserted later
    const sourceRepositoryId = IModelTransformerTestUtils.insertRepositoryLink(
      sourceDb,
      "anything.dgn",
      "https://test.bentley.com/folder/anything.dgn",
      "DGN"
    );

    const elem1Id = PhysicalModel.insert(
      sourceDb,
      IModel.rootSubjectId,
      "phys-model-in-target"
    );
    const extSrcAspect1: ExternalSourceAspectProps = {
      classFullName: ExternalSourceAspect.classFullName,
      element: { id: elem1Id },
      kind: ExternalSourceAspect.Kind.Element,
      identifier: Guid.empty, // doesn't matter, any identifier in the hypothetical source
      scope: { id: sourceRepositoryId },
    };
    const _extSrcAspect1Id = sourceDb.elements.insertAspect(extSrcAspect1);

    sourceDb.saveChanges();

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "AspectCyclicRefsTarget.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbPath, {
      rootSubject: sourceDb.rootSubject,
    });

    const transformer = new AssertOrderTransformer(
      [elem1Id, sourceRepositoryId],
      sourceDb,
      targetDb,
      { includeSourceProvenance: true }
    );

    await expect(transformer.processSchemas()).to.eventually.be.fulfilled;
    await expect(transformer.process()).to.eventually.be.fulfilled;

    const elem1InTargetId = transformer.context.findTargetElementId(elem1Id);
    const elem1AspectsInTarget = targetDb.elements.getAspects(elem1InTargetId);
    expect(elem1AspectsInTarget).to.have.lengthOf(1);

    const extSrcAspect1InTarget = elem1AspectsInTarget[0];
    assert(extSrcAspect1InTarget instanceof ExternalSourceAspect);
    expect(extSrcAspect1InTarget.identifier).to.equal(extSrcAspect1.identifier);

    const sourceRepositoryInTargetId =
      transformer.context.findTargetElementId(sourceRepositoryId);
    expect(extSrcAspect1InTarget?.scope?.id).to.equal(
      sourceRepositoryInTargetId
    );

    sourceDb.close();
    targetDb.close();
  });

  it("returns ids in order when exporting multiple ElementMultiAspect of multiple classes", async () => {
    const sourceDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "AspectIdOrderSrc.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "AspectIdOrderSource" },
    });
    await TransformerExtensiveTestScenario.prepareDb(sourceDb);

    const spatialCategoryId = SpatialCategory.insert(
      sourceDb,
      IModel.dictionaryId,
      "SpatialCategory",
      { color: ColorDef.green.toJSON() }
    );
    const physicalModelId = PhysicalModel.insert(
      sourceDb,
      IModel.rootSubjectId,
      "phys-model"
    );
    const physicalObj1InSourceId = sourceDb.elements.insertElement({
      classFullName: PhysicalObject.classFullName,
      model: physicalModelId,
      category: spatialCategoryId,
      code: Code.createEmpty(),
      userLabel: "PhysicalObject1",
      geom: TestUtils.IModelTestUtils.createBox(
        Point3d.create(1, 1, 1),
        spatialCategoryId
      ),
      placement: {
        origin: Point3d.create(1, 1, 1),
        angles: YawPitchRollAngles.createDegrees(0, 0, 0),
      },
    } as PhysicalElementProps);

    sourceDb.elements.insertAspect({
      classFullName: "ExtensiveTestScenario:AdditionalMultiAspect",
      element: new ElementOwnsMultiAspects(physicalObj1InSourceId),
      value: "1",
    } as ElementAspectProps);
    sourceDb.elements.insertAspect({
      classFullName: "ExtensiveTestScenario:SourceMultiAspect",
      element: new ElementOwnsMultiAspects(physicalObj1InSourceId),
      commonDouble: 2.2,
      commonString: "2",
      commonLong: physicalObj1InSourceId,
      sourceDouble: 22.2,
      sourceString: "2",
      sourceLong: physicalObj1InSourceId,
      sourceGuid: Guid.createValue(),
      extraString: "2",
    } as ElementAspectProps);
    sourceDb.elements.insertAspect({
      classFullName: "ExtensiveTestScenario:AdditionalMultiAspect",
      element: new ElementOwnsMultiAspects(physicalObj1InSourceId),
      value: "3",
    } as ElementAspectProps);
    sourceDb.saveChanges();

    const targetDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "AspectIdOrderTarget.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "AspectIdOrderTarget" },
    });
    await TransformerExtensiveTestScenario.prepareDb(targetDb);
    targetDb.saveChanges();

    const importer = new AspectTrackingImporter(targetDb);
    const transformer = new AspectTrackingTransformer(sourceDb, importer);
    assert.isTrue(transformer.context.isBetweenIModels);
    await transformer.process();
    transformer.dispose();

    const physicalObj1InTargetId = IModelTransformerTestUtils.queryByUserLabel(
      targetDb,
      "PhysicalObject1"
    );
    assert(physicalObj1InSourceId !== Id64.invalid);
    assert(physicalObj1InTargetId !== Id64.invalid);

    const exportedAspectSources = transformer.exportedAspectIdsByElement.get(
      physicalObj1InSourceId
    );
    const importedAspectTargetIds = importer.importedAspectIdsByElement.get(
      physicalObj1InTargetId
    );
    assert(exportedAspectSources !== undefined);
    assert(importedAspectTargetIds !== undefined);
    assert(exportedAspectSources.length === importedAspectTargetIds.length);

    // confirm the assumption that there are multiple aspect classes and their instances are not consecutive
    expect(
      exportedAspectSources[0].classFullName !==
        exportedAspectSources[1].classFullName &&
        exportedAspectSources[1].classFullName !==
          exportedAspectSources[2].classFullName &&
        exportedAspectSources[0].classFullName ===
          exportedAspectSources[2].classFullName
    );

    for (let i = 0; i < exportedAspectSources.length; ++i) {
      const sourceId = exportedAspectSources[i].id;
      const targetId = importedAspectTargetIds[i];
      const mappedTarget = transformer.context.findTargetAspectId(sourceId);
      assert(mappedTarget !== Id64.invalid);
      const indexInResult = importedAspectTargetIds.findIndex(
        (id) => id === mappedTarget
      );
      assert(
        mappedTarget === targetId,
        `aspect ${i} (${sourceId} in source, ${mappedTarget} in target) but got ${targetId} and the expected id was at index ${indexInResult}`
      );
    }
  });

  it("handles nested schema references during schema export", async () => {
    const sourceDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "NestedSchemaOrderSrc.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "NestedSchemaOrderSrc" },
    });

    const testSchema1 = `
      <?xml version="1.0" encoding="UTF-8"?>
      <ECSchema schemaName="TestSchema1" alias="ts1" version="01.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1">
        <ECSchemaReference name="Units" version="01.00.05" alias="u"/>
      </ECSchema>`;

    const testSchema2 = `
      <?xml version="1.0" encoding="UTF-8"?>
      <ECSchema schemaName="TestSchema2" alias="ts2" version="01.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1">
          <ECSchemaReference name="TestSchema1" version="01.00" alias="ts1"/>
          <ECSchemaReference name="BisCore" version="01.00" alias="bis"/>
          <ECEntityClass typeName="TestElement">
            <BaseClass>bis:PhysicalElement</BaseClass>
            <ECProperty propertyName="MyProp1" typeName="string"/>
          </ECEntityClass>
      </ECSchema>`;

    await sourceDb.importSchemaStrings([testSchema1, testSchema2]);
    sourceDb.saveChanges();

    const targetDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "NestedSchemaRefs.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "NestedSchemaRefsTarget" },
    });

    const transformer = new IModelTransformer(sourceDb, targetDb);
    assert.isTrue(transformer.context.isBetweenIModels);
    // no need to expect.eventually.fulfilled, because chai-as-promised ellipses long error messages so best
    // to just let it throw itself since that's what we're testing
    await transformer.processSchemas();
    transformer.dispose();
  });

  it("handles unknown new schema references in biscore", async () => {
    const sourceDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "UnknownBisCoreNewSchemaRef.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "UnknownBisCoreNewSchemaRef" },
    });

    const biscoreVersion = sourceDb.querySchemaVersion("BisCore");
    assert(biscoreVersion !== undefined);
    const fakeSchemaVersion = "1.0.99";
    expect(Semver.lt(biscoreVersion, fakeSchemaVersion)).to.be.true;

    const biscoreText = await SchemaTestUtils.schemaToXmlString(
      "BisCore",
      sourceDb
    );
    assert(biscoreText !== undefined);

    const fakeBisCoreUpdateText = biscoreText
      .replace(
        /(<ECSchema .*?>)/,
        '$1 <ECSchemaReference name="NewRef" version="01.00.00" alias="nr"/>'
      )
      .replace(/(?<=alias="bis" version=")[^"]*(?=")/, fakeSchemaVersion);
    // console.log(fakeBisCoreUpdateText.slice(0, 2000));

    const newReffedSchema = `<?xml version="1.0" encoding="UTF-8"?>
      <ECSchema schemaName="NewRef" alias="nr" version="01.00.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1">
        <ECSchemaReference name="units" version="01.00" alias="u"/>
      </ECSchema>
    `;

    await sourceDb.importSchemaStrings([
      newReffedSchema,
      fakeBisCoreUpdateText,
    ]);
    sourceDb.saveChanges();

    const targetDb1File = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "UnknownBisCoreNewSchemaRefTarget1.bim"
    );
    const targetDb1 = SnapshotDb.createEmpty(targetDb1File, {
      rootSubject: { name: "UnknownBisCoreNewSchemaRefTarget1" },
    });

    const transformer = new IModelTransformer(sourceDb, targetDb1);
    expect(transformer.exporter.wantSystemSchemas).to.be.true;
    await transformer.processSchemas();
    transformer.dispose();

    const targetDb2File = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "UnknownBisCoreNewSchemaRefTarget2.bim"
    );
    const targetDb2 = SnapshotDb.createEmpty(targetDb2File, {
      rootSubject: { name: "UnknownBisCoreNewSchemaRefTarget2" },
    });

    const noSystemSchemasExporter = new IModelExporter(sourceDb);
    noSystemSchemasExporter.wantSystemSchemas = false;
    const noSystemSchemasTransformer = new IModelTransformer(
      noSystemSchemasExporter,
      targetDb2
    );
    expect(noSystemSchemasExporter.wantSystemSchemas).to.be.false;
    expect(noSystemSchemasTransformer.exporter.wantSystemSchemas).to.be.false;
    await noSystemSchemasTransformer.processSchemas();
    noSystemSchemasTransformer.dispose();
  });

  it("transform iModels with profile upgrade", async () => {
    const oldDbPath = TestUtils.IModelTestUtils.resolveAssetFile(
      "CompatibilityTestSeed.bim"
    );
    const oldDb = SnapshotDb.openFile(oldDbPath);

    const newDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "ProfileTests-New.bim"
    );
    let newDb = SnapshotDb.createFrom(oldDb, newDbPath);
    newDb.close();
    setToStandalone(newDbPath);
    StandaloneDb.upgradeStandaloneSchemas(newDbPath);
    newDb = SnapshotDb.openFile(newDbPath);

    const bisCoreVersionInOld = oldDb.querySchemaVersion("BisCore")!;
    const bisCoreVersionInNew = newDb.querySchemaVersion("BisCore")!;
    assert(
      Semver.lt(
        Schema.toSemverString(bisCoreVersionInOld),
        Schema.toSemverString(bisCoreVersionInNew)
      ),
      `The 'old' database with biscore version ${bisCoreVersionInOld} was not less than the 'new' database biscore of ${bisCoreVersionInNew}`
    );

    const oldDbProfileIsOlder =
      cmpProfileVersion(getProfileVersion(oldDb), getProfileVersion(newDb)) ===
      -1;
    assert(
      oldDbProfileIsOlder,
      "The 'old' database unexpectedly did not have an older profile version"
    );

    const sourceDbs = [oldDb, newDb];
    const targetSeeds = [oldDb, newDb];
    const doUpgradeVariants = [true, false];

    const targetDbPath = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "ProfileTests-Target.bim"
    );

    const expectedFailureCases = [
      { sourceDb: newDb, targetSeed: oldDb, doUpgrade: false },
    ] as const;

    /* eslint-disable @typescript-eslint/indent */
    /* eslint-disable @typescript-eslint/indent */
    for (const sourceDb of sourceDbs)
      for (const targetSeed of targetSeeds)
        for (const doUpgrade of doUpgradeVariants) {
          if (IModelJsFs.existsSync(targetDbPath))
            IModelJsFs.unlinkSync(targetDbPath);

          let targetDb: IModelDb = SnapshotDb.createFrom(
            targetSeed,
            targetDbPath
          );
          targetDb.close();
          setToStandalone(targetDbPath);
          if (doUpgrade) StandaloneDb.upgradeStandaloneSchemas(targetDbPath);
          targetDb = StandaloneDb.openFile(targetDbPath);

          const transformer = new IModelTransformer(sourceDb, targetDb);
          try {
            await transformer.processSchemas();
          } catch (err) {
            const wasExpected = expectedFailureCases.find(
              (c) =>
                c.sourceDb.pathName === sourceDb.pathName &&
                c.targetSeed.pathName === targetSeed.pathName &&
                c.doUpgrade === doUpgrade
            );
            if (!wasExpected) {
              // eslint-disable-next-line no-console
              console.log(
                [
                  "Unexpected failure:",
                  `sourceDb: ${sourceDb.pathName}`,
                  `targetSeed: ${targetSeed.pathName}`,
                  `doUpgrade: ${doUpgrade}`,
                ].join("\n")
              );
              throw err;
            }
          }

          transformer.dispose();
          targetDb.close();
        }

    oldDb.close();
    newDb.close();
  });

  it("transforms code values with non standard space characters", async () => {
    const sourceDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "CodeValNbspSrc.bim"
    );
    let sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "CodeValNbspSrc" },
    });

    const nbsp = "\xa0";

    const spatialCategId = SpatialCategory.insert(
      sourceDb,
      IModelDb.dictionaryId,
      `SpatialCategory${nbsp}`,
      {}
    );
    const subCategId = Id64.fromUint32Pair(parseInt(spatialCategId, 16) + 1, 0);
    const physModelId = PhysicalModel.insert(
      sourceDb,
      IModelDb.rootSubjectId,
      `PhysicalModel${nbsp}`
    );

    const physObjectProps: PhysicalElementProps = {
      classFullName: PhysicalObject.classFullName,
      model: physModelId,
      category: spatialCategId,
      code: new Code({
        scope: "0x1",
        spec: "0x1",
        value: `PhysicalObject${nbsp}`,
      }),
      userLabel: `PhysicalObject${nbsp}`,
      geom: IModelTransformerTestUtils.createBox(Point3d.create(1, 1, 1)),
      placement: Placement3d.fromJSON({ origin: { x: 0 }, angles: {} }),
    };

    const physObjectId = sourceDb.elements.insertElement(physObjectProps);

    sourceDb.saveChanges();

    expect(sourceDb.elements.getElement(spatialCategId).code.value).to.equal(
      "SpatialCategory"
    );
    expect(sourceDb.elements.getElement(subCategId).code.value).to.equal(
      "SpatialCategory"
    );
    expect(sourceDb.elements.getElement(physModelId).code.value).to.equal(
      "PhysicalModel"
    );
    expect(sourceDb.elements.getElement(physObjectId).code.value).to.equal(
      "PhysicalObject"
    );

    const addNonBreakingSpaceToCodeValue = (
      db: IModelDb,
      initialCodeValue: string
    ) =>
      db.withSqliteStatement(
        `UPDATE bis_Element SET CodeValue='${initialCodeValue}\xa0' WHERE CodeValue='${initialCodeValue}'`,
        (s) => {
          let result: DbResult;
          while ((result = s.step()) === DbResult.BE_SQLITE_ROW) {}
          assert(result === DbResult.BE_SQLITE_DONE);
        }
      );

    for (const label of ["SpatialCategory", "PhysicalModel", "PhysicalObject"])
      addNonBreakingSpaceToCodeValue(sourceDb, label);

    const getCodeValRawSqlite = (
      db: IModelDb,
      args: { initialVal: string; expected: string; expectedMatchCount: number }
    ) => {
      db.withSqliteStatement(
        `SELECT CodeValue FROM bis_Element WHERE CodeValue LIKE '${args.initialVal}%'`,
        (stmt) => {
          let rows = 0;
          for (const { codeValue } of stmt) {
            rows++;
            expect(codeValue).to.equal(args.expected);
          }
          expect(rows).to.equal(args.expectedMatchCount);
        }
      );
    };

    const getCodeValEcSql = (
      db: IModelDb,
      args: { initialVal: string; expected: string; expectedMatchCount: number }
    ) => {
      db.withStatement(
        `SELECT CodeValue FROM bis.Element WHERE CodeValue LIKE '${args.initialVal}%'`,
        (stmt) => {
          let rows = 0;
          for (const { codeValue } of stmt) {
            rows++;
            expect(codeValue).to.equal(args.expected);
          }
          expect(rows).to.equal(args.expectedMatchCount);
        }
      );
    };

    // eslint-disable-next-line @typescript-eslint/no-shadow
    for (const [initialVal, expectedMatchCount] of [
      ["SpatialCategory", 2],
      ["PhysicalModel", 1],
      ["PhysicalObject", 1],
    ] as const) {
      getCodeValRawSqlite(sourceDb, {
        initialVal,
        expected: `${initialVal}\xa0`,
        expectedMatchCount,
      });
      getCodeValEcSql(sourceDb, {
        initialVal,
        expected: `${initialVal}\xa0`,
        expectedMatchCount,
      });
    }

    sourceDb.saveChanges();
    sourceDb.close();
    sourceDb = SnapshotDb.openFile(sourceDbFile);

    // eslint-disable-next-line @typescript-eslint/no-shadow
    for (const [initialVal, expectedMatchCount] of [
      ["SpatialCategory", 2],
      ["PhysicalModel", 1],
      ["PhysicalObject", 1],
    ] as const) {
      getCodeValRawSqlite(sourceDb, {
        initialVal,
        expected: `${initialVal}\xa0`,
        expectedMatchCount,
      });
      getCodeValEcSql(sourceDb, {
        initialVal,
        expected: `${initialVal}\xa0`,
        expectedMatchCount,
      });
    }

    const targetDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "CoreNewSchemaRefTarget.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "CodeValNbspTarget" },
    });

    const transformer = new IModelTransformer(sourceDb, targetDb);
    await transformer.process();

    const spatialCategoryInTargetId =
      transformer.context.findTargetElementId(spatialCategId);
    const subCategoryInTargetId =
      transformer.context.findTargetElementId(subCategId);
    const physModelInTargetId =
      transformer.context.findTargetElementId(physModelId);
    const physObjectInTargetId =
      transformer.context.findTargetElementId(physObjectId);

    expect(
      targetDb.elements.getElement(spatialCategoryInTargetId).code.value
    ).to.equal("SpatialCategory");
    expect(
      targetDb.elements.getElement(subCategoryInTargetId).code.value
    ).to.equal("SpatialCategory");
    expect(
      targetDb.elements.getElement(physModelInTargetId).code.value
    ).to.equal("PhysicalModel");
    expect(
      targetDb.elements.getElement(physObjectInTargetId).code.value
    ).to.equal("PhysicalObject");

    // eslint-disable-next-line @typescript-eslint/no-shadow
    for (const [initialVal, expectedMatchCount] of [
      ["SpatialCategory", 2],
      ["PhysicalModel", 1],
      ["PhysicalObject", 1],
    ] as const) {
      // some versions of itwin.js do not have a code path for the transformer to preserve bad codes
      const inITwinJsVersionWithExactCodeFeature = Semver.satisfies(
        coreBackendPkgJson.version,
        "^3.0.0 || ^4.1.1"
      );
      const expected = inITwinJsVersionWithExactCodeFeature
        ? `${initialVal}\xa0`
        : initialVal;
      getCodeValRawSqlite(targetDb, {
        initialVal,
        expected,
        expectedMatchCount,
      });
      getCodeValEcSql(targetDb, { initialVal, expected, expectedMatchCount });
    }

    transformer.dispose();
    sourceDb.close();
    targetDb.close();
  });

  it("should not change code scope to root subject when code spec type is Repository", async () => {
    const sourceDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "source-with-bad-CodeScopes.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "Separate Models" },
    });
    const codeSpec = CodeSpec.create(
      sourceDb,
      "Test CodeSpec",
      CodeScopeSpec.Type.Repository,
      CodeScopeSpec.ScopeRequirement.ElementId
    );
    const codeSpecId = sourceDb.codeSpecs.insert(codeSpec);
    const category = SpatialCategory.insert(
      sourceDb,
      IModel.dictionaryId,
      "TestCategory",
      {}
    );
    const subject = Subject.insert(
      sourceDb,
      IModel.rootSubjectId,
      "Clashing Codes Container"
    );
    const model1 = PhysicalModel.insert(sourceDb, subject, "Model 1");
    const model2 = PhysicalModel.insert(sourceDb, subject, "Model 2");
    const element11Props: PhysicalElementProps = {
      category,
      classFullName: PhysicalObject.classFullName,
      code: new Code({
        scope: model1,
        spec: codeSpecId,
        value: "Clashing code",
      }),
      model: model1,
    };
    const element11 = sourceDb.elements.insertElement(element11Props);
    const element12Props: PhysicalElementProps = {
      category,
      classFullName: PhysicalObject.classFullName,
      code: new Code({ scope: model1, spec: codeSpecId, value: "Element 1.2" }),
      model: model1,
      parent: new ElementOwnsChildElements(element11),
    };
    const element12 = sourceDb.elements.insertElement(element12Props);
    const element21Props: PhysicalElementProps = {
      category,
      classFullName: PhysicalObject.classFullName,
      code: new Code({
        scope: model2,
        spec: codeSpecId,
        value: "Clashing code",
      }),
      model: model2,
    };
    const element21 = sourceDb.elements.insertElement(element21Props);
    const element22Props: PhysicalElementProps = {
      category,
      classFullName: PhysicalObject.classFullName,
      code: new Code({ scope: model2, spec: codeSpecId, value: "Element 2.2" }),
      model: model2,
      parent: new ElementOwnsChildElements(element21),
    };
    const element22 = sourceDb.elements.insertElement(element22Props);

    sourceDb.saveChanges();

    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "target-combined-model.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "Combined Model" },
    });

    const transformer = new IModelTransformer(sourceDb, targetDb);
    await expect(transformer.process()).not.to.be.rejected;
    targetDb.saveChanges();

    const targetElement11 = targetDb.elements.getElement(
      transformer.context.findTargetElementId(element11)
    );
    const targetElement12 = targetDb.elements.getElement(
      transformer.context.findTargetElementId(element12)
    );
    const targetElement21 = targetDb.elements.getElement(
      transformer.context.findTargetElementId(element21)
    );
    const targetElement22 = targetDb.elements.getElement(
      transformer.context.findTargetElementId(element22)
    );

    assert.notEqual(targetElement11.code.scope, IModel.rootSubjectId);
    assert.notEqual(targetElement12.code.scope, IModel.rootSubjectId);
    assert.notEqual(targetElement21.code.scope, IModel.rootSubjectId);
    assert.notEqual(targetElement22.code.scope, IModel.rootSubjectId);

    transformer.dispose();
    sourceDb.close();
    targetDb.close();
  });

  it("detect element deletes works on children", async () => {
    const sourceDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DetectElemDeletesChildren.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "DetectElemDeletes" },
    });
    const model = PhysicalModel.insert(
      sourceDb,
      IModelDb.rootSubjectId,
      "Model 1"
    );
    const category = SpatialCategory.insert(
      sourceDb,
      IModel.dictionaryId,
      "TestCategory",
      {}
    );
    const obj = new PhysicalObject(
      {
        code: Code.createEmpty(),
        model,
        category,
        classFullName: PhysicalObject.classFullName,
      },
      sourceDb
    );
    obj.insert();

    sourceDb.saveChanges();

    const targetDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DetectElemDeletesChildrenTarget.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "Combined Model" },
    });

    const transformer = new IModelTransformer(sourceDb, targetDb, {
      forceExternalSourceAspectProvenance: true,
    });
    await expect(transformer.process()).not.to.be.rejected;
    targetDb.saveChanges();
    const modelInTarget = transformer.context.findTargetElementId(model);
    const objInTarget = transformer.context.findTargetElementId(obj.id);

    // delete from source for detectElementDeletes to handle
    sourceDb.elements.deleteElement(obj.id);
    sourceDb.models.deleteModel(model);
    sourceDb.elements.deleteElement(model);

    expect(sourceDb.models.tryGetModel(model)).to.be.undefined;
    expect(sourceDb.elements.tryGetElement(model)).to.be.undefined;
    expect(sourceDb.elements.tryGetElement(obj)).to.be.undefined;

    sourceDb.saveChanges();

    await expect(transformer.process()).not.to.be.rejected;
    targetDb.saveChanges();

    expect(sourceDb.models.tryGetModel(modelInTarget)).to.be.undefined;
    expect(targetDb.elements.tryGetElement(modelInTarget)).to.be.undefined;
    expect(targetDb.elements.tryGetElement(objInTarget)).to.be.undefined;

    transformer.dispose();
    sourceDb.close();
    targetDb.close();
  });

  it("detect elements deletes skips elements where Identifier is not id", async () => {
    const sourceDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "SourceProvenance.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "Source Provenance Test" },
    });
    const sourceRepositoryId = IModelTransformerTestUtils.insertRepositoryLink(
      sourceDb,
      "master.dgn",
      "https://test.bentley.com/folder/master.dgn",
      "DGN"
    );
    const sourceExternalSourceId =
      IModelTransformerTestUtils.insertExternalSource(
        sourceDb,
        sourceRepositoryId,
        "Default Model"
      );
    const sourceCategoryId = SpatialCategory.insert(
      sourceDb,
      IModel.dictionaryId,
      "SpatialCategory",
      { color: ColorDef.green.toJSON() }
    );
    const sourceModelId = PhysicalModel.insert(
      sourceDb,
      IModel.rootSubjectId,
      "Physical"
    );
    const sourcePhysicalObjectsToSkip = new Set<Id64String>();
    for (const x of [1, 2, 3]) {
      const physicalObjectProps: PhysicalElementProps = {
        classFullName: PhysicalObject.classFullName,
        model: sourceModelId,
        category: sourceCategoryId,
        code: Code.createEmpty(),
      };
      const physicalObjectId =
        sourceDb.elements.insertElement(physicalObjectProps);
      sourcePhysicalObjectsToSkip.add(physicalObjectId);
      const externalSourceAspects: ExternalSourceAspectProps = {
        classFullName: ExternalSourceAspect.classFullName,
        element: {
          id: physicalObjectId,
          relClassName: ElementOwnsExternalSourceAspects.classFullName,
        },
        scope: { id: "0x1" },
        source: { id: sourceExternalSourceId },
        identifier: `notID${x}`,
        kind: ExternalSourceAspect.Kind.Element,
      };
      sourceDb.elements.insertAspect(externalSourceAspects);
    }

    const objectProps: PhysicalElementProps = {
      classFullName: PhysicalObject.classFullName,
      model: sourceModelId,
      category: sourceCategoryId,
      code: Code.createEmpty(),
    };
    const physicalObjectToDelete = sourceDb.elements.insertElement(objectProps);
    const aspectProps: ExternalSourceAspectProps = {
      classFullName: ExternalSourceAspect.classFullName,
      element: {
        id: physicalObjectToDelete,
        relClassName: ElementOwnsExternalSourceAspects.classFullName,
      },
      scope: { id: "0x1" },
      source: { id: sourceExternalSourceId },
      identifier: "0x333",
      kind: ExternalSourceAspect.Kind.Element,
    };

    sourceDb.elements.insertAspect(aspectProps);
    sourceDb.saveChanges();

    // create target iModel
    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "SourceProvenance-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "Source Provenance Test (Target)" },
    });

    // clone
    const transformer = new IModelTransformer(sourceDb, targetDb, {
      includeSourceProvenance: true,
      forceExternalSourceAspectProvenance: true,
    });
    await transformer.process();
    targetDb.saveChanges();

    // verify target contents
    for (const sourceElementId of sourcePhysicalObjectsToSkip) {
      const targetElementId =
        transformer.context.findTargetElementId(sourceElementId);
      expect(targetDb.elements.tryGetElement(targetElementId)).to.be.not
        .undefined;
    }
    const deletedElement = transformer.context.findTargetElementId(
      physicalObjectToDelete
    );
    expect(targetDb.elements.tryGetElement(deletedElement)).to.be.undefined;

    // clean up
    transformer.dispose();
    sourceDb.close();
    targetDb.close();
  });

  it("handles long schema names and references to them", async function () {
    const longSchema1Name = `ThisSchemaIs${"Long".repeat(100)}`;
    assert(Buffer.from(longSchema1Name).byteLength > 255);
    const longSchema2Name = `${longSchema1Name}ButEndsDifferently`;

    if (process.platform !== "win32") {
      // windows has no bound on path segment (file name) length, (it does have a bound on total path length),
      // so we don't expect this to throw only on Mac/Linux where 255 byte limit is common
      expect(() => fs.writeFileSync(longSchema1Name, "")).to.throw(/too long/);
    }

    const sourceDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "LongSchemaRef.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "UnknownBisCoreNewSchemaRef" },
    });

    const longSchema1 = `<?xml version="1.0" encoding="UTF-8"?>
      <ECSchema schemaName="${longSchema1Name}" alias="ls" version="01.00.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1">
        <ECSchemaReference name="units" version="01.00" alias="u"/>
      </ECSchema>
    `;

    const longSchema2 = `<?xml version="1.0" encoding="UTF-8"?>
      <ECSchema schemaName="${longSchema2Name}" alias="ls2" version="01.00.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1">
        <ECSchemaReference name="units" version="01.00" alias="u"/>
      </ECSchema>
    `;

    const reffingSchemaName = "Reffing";
    const reffingSchema = `<?xml version="1.0" encoding="UTF-8"?>
      <ECSchema schemaName="${reffingSchemaName}" alias="refg" version="01.00.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1">
        <ECSchemaReference name="${longSchema1Name}" version="01.00" alias="ls" />
        <ECSchemaReference name="${longSchema2Name}" version="01.00" alias="ls2" />
      </ECSchema>
    `;

    await sourceDb.importSchemaStrings([
      longSchema1,
      longSchema2,
      reffingSchema,
    ]);
    sourceDb.saveChanges();

    const targetDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "LongSchemaRefTarget.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "LongSchemaRefTarget" },
    });

    const exportedSchemaPaths: string[] = [];
    let outOfOrderExportedSchemas: string[];

    class TrackSchemaExportsExporter extends IModelExporter {
      public override async exportSchemas(): Promise<void> {
        await super.exportSchemas();
        assert(exportedSchemaPaths.length === 4);
        const reffingSchemaFile = path.join(
          transformer["_schemaExportDir"],
          `${reffingSchemaName}.ecschema.xml`
        );
        assert(
          exportedSchemaPaths.includes(reffingSchemaFile),
          `Expected ${reffingSchemaFile} in ${exportedSchemaPaths}`
        );
        // make sure the referencing schema is first, so it is imported first, and the schema locator is forced
        // to look for its references (like the long name schema) that haven't been imported yet
        outOfOrderExportedSchemas = [
          reffingSchemaFile,
          ...exportedSchemaPaths.filter((s) => s !== reffingSchemaFile),
        ];
      }
    }

    // using this class instead of sinon.replace provides some gurantees that subclasses can use the onExportSchema result as expected
    class TrackSchemaExportsTransformer extends IModelTransformer {
      public constructor(
        source: IModelDb,
        target: IModelDb,
        opts?: IModelTransformOptions
      ) {
        super(new TrackSchemaExportsExporter(source), target, opts);
      }
      public override async onExportSchema(schema: ECSchemaMetaData.Schema) {
        const exportResult = await super.onExportSchema(schema);
        assert(exportResult?.schemaPath); // IModelTransformer guarantees that it returns a valid schemaPath, the type is wide for subclasses
        exportedSchemaPaths.push(exportResult.schemaPath);
        return exportResult;
      }
    }

    const transformer = new TrackSchemaExportsTransformer(sourceDb, targetDb);

    try {
      // force import references out of order to make sure we hit an issue if schema locator can't find things
      sinon.replace(IModelJsFs, "readdirSync", () =>
        outOfOrderExportedSchemas.map((s) => path.basename(s))
      );
      await transformer.processSchemas();
      expect(targetDb.querySchemaVersion(longSchema1Name)).not.to.be.undefined;
      expect(targetDb.querySchemaVersion(longSchema2Name)).not.to.be.undefined;
    } finally {
      sourceDb.close();
      targetDb.close();
      transformer.dispose();
      sinon.restore();
    }
  });

  it("should transform correctly when some elements are not exported", async () => {
    // create source iModel
    const sourceDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "TransformWithSkippedElements-Source.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "TransformWithSkippedElements-Source" },
    });
    const customSchema = `<?xml version="1.0" encoding="UTF-8"?>
    <ECSchema schemaName="CustomSchema" alias="cs" version="01.00.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1" description="Custom schema to test optional reference handling when referenced elements are not exported">
      <ECSchemaReference name="BisCore" version="01.00.04" alias="bis"/>
      <ECEntityClass typeName="CustomPhysicalElement" modifier="Sealed" description="For testing optional navigational properties to skipped elements">
        <BaseClass>bis:PhysicalElement</BaseClass>
        <ECNavigationProperty propertyName="ReferencedElement" relationshipName="CustomNavigationalPropertyRelationship" direction="Forward" description="Navigational property to other CustomPhysicalElement"/>
      </ECEntityClass>
      <ECRelationshipClass typeName="CustomNavigationalPropertyRelationship" strength="referencing" modifier="None">
        <Source multiplicity="(0..*)" roleLabel="uses" polymorphic="true">
            <Class class="CustomPhysicalElement" />
        </Source>
        <Target multiplicity="(0..1)" roleLabel="is used by" polymorphic="true">
            <Class class="CustomPhysicalElement"/>
        </Target>
      </ECRelationshipClass>
    </ECSchema>
    `;
    await sourceDb.importSchemaStrings([customSchema]);
    const sourceCategoryId = SpatialCategory.insert(
      sourceDb,
      IModel.dictionaryId,
      "SpatialCategory",
      { color: ColorDef.blue.toJSON() }
    );
    const sourceModelId = PhysicalModel.insert(
      sourceDb,
      IModel.rootSubjectId,
      "PhysicalModel"
    );
    const sourceReferencedElementProps: PhysicalElementProps = {
      classFullName: "CustomSchema:CustomPhysicalElement",
      category: sourceCategoryId,
      code: Code.createEmpty(),
      userLabel: "Referenced Element",
      model: sourceModelId,
    };
    const sourceReferencedElementId = sourceDb.elements.insertElement(
      sourceReferencedElementProps
    );
    const defaultSourceReferencerElementProps = {
      classFullName: "CustomSchema:CustomPhysicalElement",
      category: sourceCategoryId,
      code: Code.createEmpty(),
      model: sourceModelId,
      referencedElement: {
        id: sourceReferencedElementId,
        relClassName: "CustomSchema:CustomNavigationalPropertyRelationship",
      },
    };

    for (let i = 0; i < 10; ++i) {
      sourceDb.elements.insertElement({
        ...defaultSourceReferencerElementProps,
        userLabel: `Referencer ${i}`,
      });
    }
    sourceDb.saveChanges();

    // create target iModel
    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "TransformWithSkippedElements-Target.bim"
    );
    const targetDb = StandaloneDb.createEmpty(targetDbFile, {
      rootSubject: { name: "TransformWithSkippedElements-Target" },
    });

    class SkipElementTransformer extends IModelTransformer {
      public skippedElement = Id64.invalid;

      public override shouldExportElement(sourceElement: Element): boolean {
        return this.skippedElement !== sourceElement.id;
      }
    }

    const transformer = new SkipElementTransformer(sourceDb, targetDb);
    transformer.skippedElement = sourceReferencedElementId;
    await transformer.processSchemas();
    await transformer.process();
    targetDb.saveChanges();

    targetDb.withPreparedStatement(
      "SELECT ReferencedElement.Id FROM CustomSchema:CustomPhysicalElement WHERE UserLabel LIKE '%Referencer%'",
      (statement) => {
        while (DbResult.BE_SQLITE_ROW === statement.step()) {
          assert(statement.getValue(0).isNull);
        }
      }
    );
  });

  it("should transform all aspects when detachedAspectProcessing is turned on", async () => {
    // arrange
    // prepare source
    const sourceDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DetachedAspectProcessing.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "DetachedAspectProcessing" },
    });
    const elements = [
      Subject.insert(sourceDb, IModel.rootSubjectId, "Subject1"),
      Subject.insert(sourceDb, IModel.rootSubjectId, "Subject2"),
    ];

    // 10 aspects in total (5 per element)
    elements.forEach((element) => {
      for (let i = 0; i < 5; ++i) {
        const aspectProps: ExternalSourceAspectProps = {
          classFullName: ExternalSourceAspect.classFullName,
          element: new ElementOwnsExternalSourceAspects(element),
          identifier: `${i}`,
          kind: "Element",
          scope: {
            id: IModel.rootSubjectId,
            relClassName: "BisCore:ElementScopesExternalSourceIdentifier",
          },
        };

        sourceDb.elements.insertAspect(aspectProps);
      }
    });

    sourceDb.saveChanges();

    // create target iModel
    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DetachedAspectProcessing-Target.bim"
    );
    const targetDb = StandaloneDb.createEmpty(targetDbFile, {
      rootSubject: { name: "DetachedAspectProcessing-Target" },
    });

    const exporter = new IModelExporter(
      sourceDb,
      DetachedExportElementAspectsStrategy
    );
    const transformer = new IModelTransformer(exporter, targetDb, {
      includeSourceProvenance: true,
    });

    // act
    await transformer.process();
    targetDb.saveChanges();

    // assert
    const numSourceSubjectIds = count(sourceDb, Subject.classFullName);
    const elementIds = targetDb.queryEntityIds({ from: Subject.classFullName });

    expect(elementIds.size).to.be.equal(numSourceSubjectIds);
    elementIds.forEach((elementId) => {
      if (elementId === IModel.rootSubjectId) {
        return;
      }
      const targetAspects = targetDb.elements.getAspects(
        elementId,
        ExternalSourceAspect.classFullName
      );
      const sourceAspects = sourceDb.elements.getAspects(
        elementId,
        ExternalSourceAspect.classFullName
      );
      expect(targetAspects.length).to.be.equal(sourceAspects.length);
    });
  });

  it("should transform all aspects when detachedAspectProcessing is turned on and schema name and aspect class name has SQLite reserved keyword", async () => {
    // arrange
    // prepare source
    const sourceDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DetachedAspectProcessingWithReservedSQLiteKeyword.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: {
        name: "DetachedAspectProcessingWithReservedSQLiteKeyword",
      },
    });
    const elements = [
      Subject.insert(sourceDb, IModel.rootSubjectId, "Subject1"),
      Subject.insert(sourceDb, IModel.rootSubjectId, "Subject2"),
    ];
    const customSchema = `<?xml version="1.0" encoding="UTF-8"?>
    <ECSchema schemaName="SELECT" alias="cs" version="01.00.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1" description="Custom schema to test aspect class which has SQLite reserved keyword as its name">
      <ECSchemaReference name="BisCore" version="01.00.04" alias="bis"/>
      <ECEntityClass typeName="JOIN" modifier="Sealed" description="Aspect class with SQLite reserved keyword">
        <BaseClass>bis:ElementMultiAspect</BaseClass>
      </ECEntityClass>
    </ECSchema>
    `;
    await sourceDb.importSchemaStrings([customSchema]);

    // 10 aspects in total (5 per element)
    elements.forEach((element) => {
      for (let i = 0; i < 5; ++i) {
        const aspectProps: ElementAspectProps = {
          classFullName: "SELECT:JOIN",
          element: new ElementOwnsMultiAspects(element),
        };

        sourceDb.elements.insertAspect(aspectProps);
      }
    });

    sourceDb.saveChanges();

    // create target iModel
    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DetachedAspectProcessingWithReservedSQLiteKeyword-Target.bim"
    );
    const targetDb = StandaloneDb.createEmpty(targetDbFile, {
      rootSubject: {
        name: "DetachedAspectProcessingWithReservedSQLiteKeyword-Target",
      },
    });

    const exporter = new IModelExporter(
      sourceDb,
      DetachedExportElementAspectsStrategy
    );
    const transformer = new IModelTransformer(exporter, targetDb, {
      includeSourceProvenance: true,
    });

    // act
    await transformer.process();
    targetDb.saveChanges();

    // assert
    const elementIds = targetDb.queryEntityIds({ from: Subject.classFullName });
    elementIds.forEach((elementId) => {
      if (elementId === IModel.rootSubjectId) {
        return;
      }
      const targetAspects = targetDb.elements.getAspects(
        elementId,
        ExternalSourceAspect.classFullName
      );
      const sourceAspects = sourceDb.elements.getAspects(
        elementId,
        ExternalSourceAspect.classFullName
      );
      expect(targetAspects.length).to.be.equal(sourceAspects.length);
    });
  });

  it("should remap textures in target iModel", async function () {
    const atleastInItjs4x = Semver.gte(coreBackendPkgJson.version, "4.0.0");
    if (!atleastInItjs4x) this.skip();

    // create source iModel
    const sourceDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "Transform3d-Source.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "Transform3d-Source" },
    });
    const categoryId = SpatialCategory.insert(
      sourceDb,
      IModel.dictionaryId,
      "SpatialCategory",
      { color: ColorDef.green.toJSON() }
    );
    const category = sourceDb.elements.getElement<SpatialCategory>(categoryId);
    const sourceModelId = PhysicalModel.insert(
      sourceDb,
      IModel.rootSubjectId,
      "Physical"
    );

    const renderMaterialBothImgsId = RenderMaterialElement.insert(
      sourceDb,
      IModel.dictionaryId,
      "TextureMaterialBothImgs",
      {
        paletteName: "something",
      }
    );

    const texture1Id = Texture.insertTexture(
      sourceDb,
      IModel.dictionaryId,
      "Texture1",
      ImageSourceFormat.Png,
      TestUtils.samplePngTexture.base64,
      "texture 1"
    );
    const texture2Id = Texture.insertTexture(
      sourceDb,
      IModel.dictionaryId,
      "Texture2",
      ImageSourceFormat.Png,
      TestUtils.samplePngTexture.base64,
      "texture 2"
    );

    const renderMaterialBothImgs =
      sourceDb.elements.getElement<RenderMaterialElement>(
        renderMaterialBothImgsId
      );
    // update the texture id into the model so that they are processed out of order (material exported before texture)
    if (
      renderMaterialBothImgs.jsonProperties.materialAssets.renderMaterial
        .Map === undefined
    )
      renderMaterialBothImgs.jsonProperties.materialAssets.renderMaterial.Map =
        {};
    if (
      renderMaterialBothImgs.jsonProperties.materialAssets.renderMaterial.Map
        .Pattern === undefined
    )
      renderMaterialBothImgs.jsonProperties.materialAssets.renderMaterial.Map.Pattern =
        {};
    if (
      renderMaterialBothImgs.jsonProperties.materialAssets.renderMaterial.Map
        .Normal === undefined
    )
      renderMaterialBothImgs.jsonProperties.materialAssets.renderMaterial.Map.Normal =
        {};
    renderMaterialBothImgs.jsonProperties.materialAssets.renderMaterial.Map.TextureId =
      texture1Id;
    renderMaterialBothImgs.jsonProperties.materialAssets.renderMaterial.Map.Pattern.TextureId =
      texture1Id;
    renderMaterialBothImgs.jsonProperties.materialAssets.renderMaterial.Map.Normal.TextureId =
      texture2Id;
    renderMaterialBothImgs.update();

    const renderMaterialOnlyPatternId = RenderMaterialElement.insert(
      sourceDb,
      IModel.dictionaryId,
      "TextureMaterialOnlyPattern",
      {
        paletteName: "something",
        patternMap: {
          TextureId: texture1Id, // eslint-disable-line @typescript-eslint/naming-convention
        },
      }
    );

    const renderMaterialOnlyNormalId = RenderMaterialElement.insert(
      sourceDb,
      IModel.dictionaryId,
      "TextureMaterialOnlyNormal",
      {
        paletteName: "something",
        normalMap: {
          TextureId: texture2Id, // eslint-disable-line @typescript-eslint/naming-convention
        },
      }
    );

    const physObjs = [
      renderMaterialBothImgsId,
      renderMaterialOnlyNormalId,
      renderMaterialOnlyPatternId,
    ].map((renderMaterialId) => {
      const physicalObjectProps1: PhysicalElementProps = {
        classFullName: PhysicalObject.classFullName,
        model: sourceModelId,
        category: categoryId,
        code: Code.createEmpty(),
        userLabel: "PhysicalObject",
        geom: IModelTransformerTestUtils.createBox(
          Point3d.create(1, 1, 1),
          categoryId,
          category.myDefaultSubCategoryId(),
          renderMaterialId
        ),
        placement: Placement3d.fromJSON({ origin: { x: 0, y: 0 }, angles: {} }),
      };
      return sourceDb.elements.insertElement(physicalObjectProps1);
    });

    // create target iModel
    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "Transform3d-Target.bim"
    );
    const createTargetDb = () =>
      StandaloneDb.createEmpty(targetDbFile, {
        rootSubject: { name: "Transform3d-Target" },
      });

    // transform
    const transformer = new AssertOrderAndShiftIdsTransformer(
      [renderMaterialBothImgsId, texture1Id],
      sourceDb,
      createTargetDb
    );
    await transformer.process();

    const texture1IdInTarget =
      transformer.context.findTargetElementId(texture1Id);
    const texture2IdInTarget =
      transformer.context.findTargetElementId(texture2Id);
    assert(Id64.isValidId64(texture1IdInTarget));
    assert(Id64.isValidId64(texture2IdInTarget));

    for (const objId of physObjs) {
      const objInTargetId = transformer.context.findTargetElementId(objId);
      const objInTarget =
        transformer.targetDb.elements.getElement<PhysicalObject>({
          id: objInTargetId,
          wantGeometry: true,
        });
      assert(objInTarget.geom);
      const materialOfObjInTargetId = objInTarget.geom.find(
        (g) => g.material?.materialId
      )?.material?.materialId;
      assert(materialOfObjInTargetId);

      const materialOfObjInTarget =
        transformer.targetDb.elements.getElement<RenderMaterialElement>(
          materialOfObjInTargetId
        );
      if (
        materialOfObjInTarget.jsonProperties.materialAssets.renderMaterial.Map
          .Pattern
      )
        expect(
          materialOfObjInTarget.jsonProperties.materialAssets.renderMaterial.Map
            .Pattern.TextureId
        ).to.equal(texture1IdInTarget);
      if (
        materialOfObjInTarget.jsonProperties.materialAssets.renderMaterial.Map
          .Normal
      )
        expect(
          materialOfObjInTarget.jsonProperties.materialAssets.renderMaterial.Map
            .Normal.TextureId
        ).to.equal(texture2IdInTarget);
    }

    // clean up
    transformer.dispose();
    sourceDb.close();
    transformer.targetDb.close();
  });

  it("handle same name dynamic schemas", async function () {
    const makeDynamicSchema = (
      version: string
    ) => `<?xml version="1.0" encoding="UTF-8"?>
        <ECSchema schemaName="Dynamic" alias="d1" version="${version}" displayLabel="dyn" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.2">
            <ECCustomAttributes>
                <DynamicSchema xmlns="CoreCustomAttributes.01.00.03"/>
            </ECCustomAttributes>
        </ECSchema>
    `;

    const sourceDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DynSchemas-Source.bim"
    );
    const sourceDb = SnapshotDb.createEmpty(sourceDbFile, {
      rootSubject: { name: "DynSchemaSource" },
    });
    await sourceDb.importSchemaStrings([makeDynamicSchema("01.07.00")]);
    sourceDb.saveChanges();

    const targetDbFile: string = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "DynSchemas-Target.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "DynSchemasTarget" },
    });
    await targetDb.importSchemaStrings([makeDynamicSchema("01.05.02")]);
    targetDb.saveChanges();

    const transformer = new IModelTransformer(sourceDb, targetDb);
    // expect this to not reject, adding chai as promised makes the error less readable
    await transformer.processSchemas();

    expect(targetDb.querySchemaVersion("Dynamic")).to.equal("1.7.0");

    // clean up
    transformer.dispose();
    sourceDb.close();
    targetDb.close();
  });

  /** unskip to generate a javascript CPU profile on just the processAll portion of an iModel */
  it.skip("should profile an IModel transformation", async function () {
    const sourceDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "ProfileTransformation.bim"
    );
    const sourceDb = SnapshotDb.createFrom(
      await ReusedSnapshots.extensiveTestScenario,
      sourceDbFile
    );
    const targetDbFile = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "ProfileTransformationTarget.bim"
    );
    const targetDb = SnapshotDb.createEmpty(targetDbFile, {
      rootSubject: { name: "ProfileTransformationTarget" },
    });
    const transformer = new IModelTransformer(sourceDb, targetDb);
    // force initialize to not profile the schema reference cache hydration that will happen the first time an IModelCloneContext is created
    await transformer.initialize();
    await transformer.processSchemas();
    await runWithCpuProfiler(
      async () => {
        await transformer.process();
      },
      {
        profileName: `newbranch_${this.test?.title.replace(/ /g, "_")}`,
        timestamp: true,
        sampleIntervalMicroSec: 30, // this is a quick transformation, let's get more resolution
      }
    );
    transformer.dispose();
    sourceDb.close();
    targetDb.close();
  });
});
