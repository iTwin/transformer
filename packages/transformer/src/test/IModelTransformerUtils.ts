/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/

import { assert, expect } from "chai";
import * as path from "path";
import * as fs from "fs";
import * as inspector from "inspector";
import {
  CompressedId64Set,
  DbResult,
  Guid,
  Id64,
  Id64Set,
  Id64String,
  Mutable,
} from "@itwin/core-bentley";
import { Schema } from "@itwin/ecschema-metadata";
import { Point3d, Transform, YawPitchRollAngles } from "@itwin/core-geometry";
import {
  AuxCoordSystem,
  AuxCoordSystem2d,
  CategorySelector,
  DefinitionModel,
  DisplayStyle3d,
  DrawingCategory,
  DrawingGraphicRepresentsElement,
  ECSqlStatement,
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  Element,
  ElementAspect,
  ElementMultiAspect,
  ElementUniqueAspect,
  Entity,
  ExternalSourceAspect,
  FunctionalSchema,
  GeometricElement3d,
  GeometryPart,
  HubMock,
  IModelDb,
  IModelJsFs,
  InformationPartitionElement,
  InformationRecordModel,
  Model,
  ModelSelector,
  OrthographicViewDefinition,
  PhysicalElement,
  PhysicalModel,
  PhysicalObject,
  PhysicalPartition,
  Relationship,
  RelationshipProps,
  RenderMaterialElement,
  SnapshotDb,
  SpatialCategory,
  SpatialLocationModel,
  SpatialViewDefinition,
  SubCategory,
  Subject,
  Texture,
} from "@itwin/core-backend";
import * as TestUtils from "./TestUtils";
import {
  Base64EncodedString,
  BisCodeSpec,
  CategorySelectorProps,
  Code,
  CodeScopeSpec,
  CodeSpec,
  ColorDef,
  DisplayStyle3dSettingsProps,
  ElementAspectProps,
  ElementProps,
  EntityMetaData,
  FontProps,
  GeometricElement3dProps,
  GeometryStreamIterator,
  IModel,
  ModelProps,
  ModelSelectorProps,
  PhysicalElementProps,
  Placement3d,
  QueryRowFormat,
  SkyBoxImageProps,
  SkyBoxImageType,
  SpatialViewDefinitionProps,
  SubCategoryAppearance,
  SubjectProps,
  ViewDetails3dProps,
} from "@itwin/core-common";
import { IModelExporter, IModelExportHandler } from "../IModelExporter";
import { IModelImporter, IModelImportOptions } from "../IModelImporter";
import {
  IModelTransformer,
  IModelTransformOptions,
  ProcessChangesOptions,
  RelationshipPropsForDelete,
} from "../IModelTransformer";
import { KnownTestLocations } from "./TestUtils/KnownTestLocations";

export class HubWrappers extends TestUtils.HubWrappers {
  protected static override get hubMock() {
    return HubMock;
  }
}

export class IModelTransformerTestUtils extends TestUtils.IModelTestUtils {
  protected static override get knownTestLocations(): {
    outputDir: string;
    assetsDir: string;
  } {
    return KnownTestLocations;
  }

  public static createTeamIModel(
    outputDir: string,
    teamName: string,
    teamOrigin: Point3d,
    teamColor: ColorDef,
    rootSubjectDescription?: string
  ): SnapshotDb {
    const teamFile: string = path.join(outputDir, `Team${teamName}.bim`);
    if (IModelJsFs.existsSync(teamFile)) {
      IModelJsFs.removeSync(teamFile);
    }
    const iModelDb: SnapshotDb = SnapshotDb.createEmpty(teamFile, {
      rootSubject: { name: teamName, description: rootSubjectDescription },
      createClassViews: true,
    });
    assert.exists(iModelDb);
    IModelTransformerTestUtils.populateTeamIModel(
      iModelDb,
      teamName,
      teamOrigin,
      teamColor
    );
    iModelDb.saveChanges();
    return iModelDb;
  }

  /** Returns path to a schema which contains a multiAspect TestSchema2:MyMultiAspect.
   * The schema is created in the output directory.
   * The multi aspect has a prop 'MyProp1'.
   * Users should import this schema in order to insert multi aspects.
   */
  public static getPathToSchemaWithMultiAspect(): string {
    const testSchema1Path = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "TestSchema2.ecschema.xml"
    );
    IModelJsFs.writeFileSync(
      testSchema1Path,
      `<?xml version="1.0" encoding="UTF-8"?>
        <ECSchema schemaName="TestSchema2" alias="ts1" version="01.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1">
            <ECSchemaReference name="BisCore" version="01.00" alias="bis"/>
            <ECEntityClass typeName="MyMultiAspect" description="A test unique aspect" displayLabel="a test unique aspect" modifier="Sealed">
              <BaseClass>bis:ElementMultiAspect</BaseClass>
              <ECProperty propertyName="MyProp1" typeName="string"/>
          </ECEntityClass>
        </ECSchema>`
    );
    return testSchema1Path;
  }

  /** Returns path to a schema which contains a UniqueAspect TestSchema1:MyUniqueAspect.
   * The schema is created in the output directory.
   * the only two ElementUniqueAspect's in bis are ignored by the transformer, so we can add our own to test their export
   * The unique aspect has a prop 'MyProp1'.
   * Users should import this schema in order to insert unique aspects.
   */
  public static getPathToSchemaWithUniqueAspect(): string {
    const testSchema1Path = IModelTransformerTestUtils.prepareOutputFile(
      "IModelTransformer",
      "TestSchema1.ecschema.xml"
    );
    IModelJsFs.writeFileSync(
      testSchema1Path,
      `<?xml version="1.0" encoding="UTF-8"?>
      <ECSchema schemaName="TestSchema1" alias="ts1" version="01.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.1">
          <ECSchemaReference name="BisCore" version="01.00" alias="bis"/>
          <ECEntityClass typeName="MyUniqueAspect" description="A test unique aspect" displayLabel="a test unique aspect" modifier="Sealed">
            <BaseClass>bis:ElementUniqueAspect</BaseClass>
            <ECProperty propertyName="MyProp1" typeName="string"/>
        </ECEntityClass>
      </ECSchema>`
    );
    return testSchema1Path;
  }

  public static populateTeamIModel(
    teamDb: IModelDb,
    teamName: string,
    teamOrigin: Point3d,
    teamColor: ColorDef
  ): void {
    const contextSubjectId: Id64String = Subject.insert(
      teamDb,
      IModel.rootSubjectId,
      "Context"
    );
    assert.isTrue(Id64.isValidId64(contextSubjectId));
    const definitionModelId = DefinitionModel.insert(
      teamDb,
      IModel.rootSubjectId,
      `Definition${teamName}`
    );
    assert.isTrue(Id64.isValidId64(definitionModelId));
    const teamSpatialCategoryId = this.insertSpatialCategory(
      teamDb,
      definitionModelId,
      `SpatialCategory${teamName}`,
      teamColor
    );
    assert.isTrue(Id64.isValidId64(teamSpatialCategoryId));
    const sharedSpatialCategoryId = this.insertSpatialCategory(
      teamDb,
      IModel.dictionaryId,
      "SpatialCategoryShared",
      ColorDef.white
    );
    assert.isTrue(Id64.isValidId64(sharedSpatialCategoryId));
    const sharedDrawingCategoryId = DrawingCategory.insert(
      teamDb,
      IModel.dictionaryId,
      "DrawingCategoryShared",
      new SubCategoryAppearance()
    );
    assert.isTrue(Id64.isValidId64(sharedDrawingCategoryId));
    const physicalModelId = PhysicalModel.insert(
      teamDb,
      IModel.rootSubjectId,
      `Physical${teamName}`
    );
    assert.isTrue(Id64.isValidId64(physicalModelId));
    // insert PhysicalObject-team1 using team SpatialCategory
    const physicalObjectProps1: PhysicalElementProps = {
      classFullName: PhysicalObject.classFullName,
      model: physicalModelId,
      category: teamSpatialCategoryId,
      code: Code.createEmpty(),
      userLabel: `PhysicalObject${teamName}1`,
      geom: this.createBox(Point3d.create(1, 1, 1)),
      placement: {
        origin: teamOrigin,
        angles: YawPitchRollAngles.createDegrees(0, 0, 0),
      },
    };
    const physicalObjectId1: Id64String =
      teamDb.elements.insertElement(physicalObjectProps1);
    assert.isTrue(Id64.isValidId64(physicalObjectId1));
    // insert PhysicalObject2 using "shared" SpatialCategory
    const physicalObjectProps2: PhysicalElementProps = {
      classFullName: PhysicalObject.classFullName,
      model: physicalModelId,
      category: sharedSpatialCategoryId,
      code: Code.createEmpty(),
      userLabel: `PhysicalObject${teamName}2`,
      geom: this.createBox(Point3d.create(2, 2, 2)),
      placement: {
        origin: teamOrigin,
        angles: YawPitchRollAngles.createDegrees(0, 0, 0),
      },
    };
    const physicalObjectId2: Id64String =
      teamDb.elements.insertElement(physicalObjectProps2);
    assert.isTrue(Id64.isValidId64(physicalObjectId2));
  }

  public static createSharedIModel(
    outputDir: string,
    teamNames: string[],
    rootSubjectDescription?: string
  ): SnapshotDb {
    const iModelName: string = `Shared${teamNames.join("")}`;
    const iModelFile: string = path.join(outputDir, `${iModelName}.bim`);
    if (IModelJsFs.existsSync(iModelFile)) {
      IModelJsFs.removeSync(iModelFile);
    }
    const iModelDb: SnapshotDb = SnapshotDb.createEmpty(iModelFile, {
      rootSubject: { name: iModelName, description: rootSubjectDescription },
    });
    assert.exists(iModelDb);
    teamNames.forEach((teamName: string) => {
      const subjectId: Id64String = Subject.insert(
        iModelDb,
        IModel.rootSubjectId,
        teamName
      );
      assert.isTrue(Id64.isValidId64(subjectId));
    });
    return iModelDb;
  }

  public static assertTeamIModelContents(
    iModelDb: IModelDb,
    teamName: string
  ): void {
    const definitionPartitionId: Id64String = this.queryDefinitionPartitionId(
      iModelDb,
      IModel.rootSubjectId,
      teamName
    );
    const teamSpatialCategoryId = this.querySpatialCategoryId(
      iModelDb,
      definitionPartitionId,
      teamName
    );
    const sharedSpatialCategoryId = this.querySpatialCategoryId(
      iModelDb,
      IModel.dictionaryId,
      "Shared"
    );
    const physicalPartitionId: Id64String = this.queryPhysicalPartitionId(
      iModelDb,
      IModel.rootSubjectId,
      teamName
    );
    const physicalObjectId1: Id64String = this.queryPhysicalElementId(
      iModelDb,
      physicalPartitionId,
      teamSpatialCategoryId,
      `${teamName}1`
    );
    const physicalObject1: PhysicalElement =
      iModelDb.elements.getElement<PhysicalElement>(physicalObjectId1);
    assert.equal(
      physicalObject1.code.spec,
      iModelDb.codeSpecs.getByName(BisCodeSpec.nullCodeSpec).id
    );
    assert.equal(physicalObject1.code.scope, IModel.rootSubjectId);
    assert.isTrue(physicalObject1.code.value === "");
    assert.equal(physicalObject1.category, teamSpatialCategoryId);
    const physicalObjectId2: Id64String = this.queryPhysicalElementId(
      iModelDb,
      physicalPartitionId,
      sharedSpatialCategoryId,
      `${teamName}2`
    );
    const physicalObject2: PhysicalElement =
      iModelDb.elements.getElement<PhysicalElement>(physicalObjectId2);
    assert.equal(physicalObject2.category, sharedSpatialCategoryId);
  }

  public static assertSharedIModelContents(
    iModelDb: IModelDb,
    teamNames: string[]
  ): void {
    const sharedSpatialCategoryId = this.querySpatialCategoryId(
      iModelDb,
      IModel.dictionaryId,
      "Shared"
    );
    assert.isTrue(Id64.isValidId64(sharedSpatialCategoryId));
    const aspects: ExternalSourceAspect[] = iModelDb.elements.getAspects(
      sharedSpatialCategoryId,
      ExternalSourceAspect.classFullName
    ) as ExternalSourceAspect[];
    assert.isAtLeast(
      teamNames.length,
      aspects.length,
      "Should have an ExternalSourceAspect from each source"
    );
    teamNames.forEach((teamName: string) => {
      const subjectId: Id64String = this.querySubjectId(iModelDb, teamName);
      const definitionPartitionId: Id64String = this.queryDefinitionPartitionId(
        iModelDb,
        subjectId,
        teamName
      );
      const teamSpatialCategoryId = this.querySpatialCategoryId(
        iModelDb,
        definitionPartitionId,
        teamName
      );
      const physicalPartitionId: Id64String = this.queryPhysicalPartitionId(
        iModelDb,
        subjectId,
        teamName
      );
      const physicalObjectId1: Id64String = this.queryPhysicalElementId(
        iModelDb,
        physicalPartitionId,
        teamSpatialCategoryId,
        `${teamName}1`
      );
      const physicalObject1: PhysicalElement =
        iModelDb.elements.getElement<PhysicalElement>(physicalObjectId1);
      assert.equal(
        physicalObject1.code.spec,
        iModelDb.codeSpecs.getByName(BisCodeSpec.nullCodeSpec).id
      );
      assert.isTrue(physicalObject1.code.value === "");
      assert.equal(physicalObject1.category, teamSpatialCategoryId);
      // provenance no longer adds an external source aspect if fedguids are available
      expect(
        iModelDb.elements.getAspects(
          physicalObjectId1,
          ExternalSourceAspect.classFullName
        )
      ).to.have.length(0);
      expect(
        iModelDb.elements.getAspects(
          teamSpatialCategoryId,
          ExternalSourceAspect.classFullName
        )
      ).to.have.length(0);
      const physicalObjectId2: Id64String = this.queryPhysicalElementId(
        iModelDb,
        physicalPartitionId,
        sharedSpatialCategoryId,
        `${teamName}2`
      );
      const physicalObject2: PhysicalElement =
        iModelDb.elements.getElement<PhysicalElement>(physicalObjectId2);
      assert.equal(physicalObject2.category, sharedSpatialCategoryId);
      expect(
        iModelDb.elements.getAspects(
          physicalObjectId2,
          ExternalSourceAspect.classFullName
        )
      ).to.have.length(0);
    });
  }

  public static createConsolidatedIModel(
    outputDir: string,
    consolidatedName: string
  ): SnapshotDb {
    const consolidatedFile: string = path.join(
      outputDir,
      `${consolidatedName}.bim`
    );
    if (IModelJsFs.existsSync(consolidatedFile)) {
      IModelJsFs.removeSync(consolidatedFile);
    }
    const consolidatedDb: SnapshotDb = SnapshotDb.createEmpty(
      consolidatedFile,
      { rootSubject: { name: `${consolidatedName}` } }
    );
    assert.exists(consolidatedDb);
    const definitionModelId = DefinitionModel.insert(
      consolidatedDb,
      IModel.rootSubjectId,
      `Definition${consolidatedName}`
    );
    assert.isTrue(Id64.isValidId64(definitionModelId));
    const physicalModelId = PhysicalModel.insert(
      consolidatedDb,
      IModel.rootSubjectId,
      `Physical${consolidatedName}`
    );
    assert.isTrue(Id64.isValidId64(physicalModelId));
    consolidatedDb.saveChanges();
    return consolidatedDb;
  }

  public static assertConsolidatedIModelContents(
    iModelDb: IModelDb,
    consolidatedName: string
  ): void {
    // assert what should exist
    const definitionModelId: Id64String = this.queryDefinitionPartitionId(
      iModelDb,
      IModel.rootSubjectId,
      consolidatedName
    );
    assert.isTrue(Id64.isValidId64(definitionModelId));
    const categoryA: Id64String = this.querySpatialCategoryId(
      iModelDb,
      definitionModelId,
      "A"
    );
    const categoryB: Id64String = this.querySpatialCategoryId(
      iModelDb,
      definitionModelId,
      "B"
    );
    assert.isTrue(Id64.isValidId64(categoryA));
    assert.isTrue(Id64.isValidId64(categoryB));
    const physicalModelId: Id64String = this.queryPhysicalPartitionId(
      iModelDb,
      IModel.rootSubjectId,
      consolidatedName
    );
    assert.isTrue(Id64.isValidId64(physicalModelId));
    this.queryPhysicalElementId(iModelDb, physicalModelId, categoryA, "A1");
    this.queryPhysicalElementId(iModelDb, physicalModelId, categoryB, "B1");
    // assert what should not exist
    assert.throws(() => this.querySubjectId(iModelDb, "A"), Error);
    assert.throws(() => this.querySubjectId(iModelDb, "B"), Error);
  }
}

/** map of properties in class's EC definition to their name in the JS implementation if different */
const aliasedProperties: Record<string, Record<string, string> | undefined> =
  new Proxy(
    {
      // can't use GeometricElement.classFullName at module scope
      ["BisCore:GeometricElement3d".toLowerCase()]: {
        geometryStream: "geom",
      },
    },
    {
      get(target, key: string, receiver) {
        return Reflect.get(target, key.toLowerCase(), receiver);
      },
    }
  );

/**
 * get all properties, including those of bases and mixins from metadata,
 * and aliases some properties where the name differs in JS land from the ec property
 */
function getAllElemMetaDataProperties(elem: Element) {
  function getAllClassMetaDataProperties(
    className: string,
    metadata: EntityMetaData
  ) {
    const allProperties = { ...metadata?.properties };
    for (const baseName of metadata?.baseClasses ?? []) {
      const base = elem.iModel.getMetaData(baseName);
      Object.assign(
        allProperties,
        getAllClassMetaDataProperties(baseName, base)
      );
    }

    Object.assign(allProperties, aliasedProperties[className.toLowerCase()]);
    return allProperties;
  }

  const classMetaData = elem.getClassMetaData();
  if (!classMetaData) return undefined;

  return getAllClassMetaDataProperties(elem.classFullName, classMetaData);
}

/**
 * Assert that an identity (no changes) transformation has occurred between two IModelDbs
 * @note If you do not pass a transformer or custom implementation of an id remapping context, it defaults to assuming
 *       no remapping occurred and therefore can be used as a general db-content-equivalence check
 */
export async function assertIdentityTransformation(
  sourceDb: IModelDb,
  targetDb: IModelDb,
  /** either an IModelTransformer instance or a function mapping source element ids to target elements */
  remapper:
    | IModelTransformer
    | {
        findTargetCodeSpecId: (id: Id64String) => Id64String;
        findTargetElementId: (id: Id64String) => Id64String;
        findTargetAspectId: (id: Id64String) => Id64String;
      } = {
    findTargetCodeSpecId: (id) => id,
    findTargetElementId: (id) => id,
    findTargetAspectId: (id) => id,
  },
  {
    allowPropChange,
    expectedElemsOnlyInSource = [],
    expectedElemsOnlyInTarget = [],
    // by default ignore the classes that the transformer ignores, this default is wrong if the option
    // [IModelTransformerOptions.includeSourceProvenance]$(transformer) is set to true
    classesToIgnoreMissingEntitiesOfInTarget = [
      ...IModelTransformer.provenanceElementClasses,
      ...IModelTransformer.provenanceElementAspectClasses,
    ],
    compareElemGeom = false,
    ignoreFedGuidsOnAlwaysPresentElementIds = true,
  }: {
    expectedElemsOnlyInSource?: Partial<ElementProps>[];
    expectedElemsOnlyInTarget?: Partial<ElementProps>[];
    /** return undefined to use the default allowProps check that expects a transformation */
    allowPropChange?: (
      sourceElem: Element,
      targetElem: Element,
      propName: string
    ) => boolean | undefined;
    /** before checking elements that are only in the source are correct, filter out elements of these classes */
    classesToIgnoreMissingEntitiesOfInTarget?: (typeof Entity)[];
    compareElemGeom?: boolean;
    /** if true, ignores the fed guids present on always present elements (present even in an empty iModel!).
     * That list includes the root subject (0x1), dictionaryModel (0x10) and the realityDataSourcesModel (0xe) */
    ignoreFedGuidsOnAlwaysPresentElementIds?: boolean;
  } = {}
) {
  const alwaysPresentElementIds = new Set<Id64String>(["0x1", "0x10", "0xe"]);
  const [remapElem, remapCodeSpec, remapAspect] =
    remapper instanceof IModelTransformer
      ? [
          remapper.context.findTargetElementId.bind(remapper.context),
          remapper.context.findTargetCodeSpecId.bind(remapper.context),
          remapper.context.findTargetAspectId.bind(remapper.context),
        ]
      : [
          remapper.findTargetElementId,
          remapper.findTargetCodeSpecId,
          remapper.findTargetAspectId,
        ];
  /* eslint-disable-next-line deprecation/deprecation */
  expect(sourceDb.nativeDb.hasUnsavedChanges()).to.be.false;
  /* eslint-disable-next-line deprecation/deprecation */
  expect(targetDb.nativeDb.hasUnsavedChanges()).to.be.false;

  const sourceToTargetElemsMap = new Map<Element, Element | undefined>();
  const targetToSourceElemsMap = new Map<Element, Element | undefined>();
  const targetElemIds = new Set<Id64String>();

  // eslint-disable-next-line deprecation/deprecation
  for await (const [sourceElemId] of sourceDb.query(
    "SELECT ECInstanceId FROM bis.Element"
  )) {
    const targetElemId = remapElem(sourceElemId);
    const sourceElem = sourceDb.elements.getElement({
      id: sourceElemId,
      wantGeometry: compareElemGeom,
    });
    const targetElem = targetDb.elements.tryGetElement({
      id: targetElemId,
      wantGeometry: compareElemGeom,
    });
    // expect(targetElem.toExist)
    sourceToTargetElemsMap.set(sourceElem, targetElem);
    if (targetElem) {
      targetElemIds.add(targetElemId);
      targetToSourceElemsMap.set(targetElem, sourceElem);
      for (const [propName, prop] of Object.entries(
        getAllElemMetaDataProperties(sourceElem) ?? {}
      )) {
        // known cases for the prop expecting to have been changed by the transformation under normal circumstances
        // - federation guid will be generated if it didn't exist
        // - jsonProperties may include remapped ids
        const propChangesAllowed =
          allowPropChange?.(sourceElem, targetElem, propName) ??
          ((propName === "federationGuid" &&
            (sourceElem.federationGuid === undefined ||
              (ignoreFedGuidsOnAlwaysPresentElementIds &&
                alwaysPresentElementIds.has(sourceElemId)))) ||
            propName === "jsonProperties");
        if (prop.isNavigation) {
          expect(sourceElem.classFullName).to.equal(targetElem.classFullName);
          // some custom handled classes make it difficult to inspect the element props directly with the metadata prop name
          // so we query the prop instead of the checking for the property on the element
          const sql = `SELECT [${propName}].Id from [${sourceElem.schemaName}].[${sourceElem.className}] WHERE ECInstanceId=:id`;
          const relationTargetInSourceId = sourceDb.withPreparedStatement(
            sql,
            (stmt) => {
              stmt.bindId("id", sourceElemId);
              stmt.step();
              return stmt.getValue(0).getId() ?? Id64.invalid;
            }
          );
          const relationTargetInTargetId = targetDb.withPreparedStatement(
            sql,
            (stmt) => {
              stmt.bindId("id", targetElemId);
              expect(stmt.step()).to.equal(DbResult.BE_SQLITE_ROW);
              return stmt.getValue(0).getId() ?? Id64.invalid;
            }
          );
          const mappedRelationTargetInTargetId = (
            propName === "codeSpec" ? remapCodeSpec : remapElem
          )(relationTargetInSourceId);
          expect(relationTargetInTargetId).to.equal(
            mappedRelationTargetInTargetId
          );
        } else if (!propChangesAllowed) {
          try {
            expect(
              (targetElem as any)[propName],
              `${targetElem.id}[${propName}] didn't match ${sourceElem.id}[${propName}]`
            ).to.deep.advancedEqual((sourceElem as any)[propName]);
          } catch (err) {
            // for debugging broken tests
            debugger; // eslint-disable-line no-debugger
            throw err;
          }
        }
      }
      const quickClone = (obj: any) => JSON.parse(JSON.stringify(obj));
      const expectedSourceElemJsonProps = quickClone(sourceElem.jsonProperties);

      // START jsonProperties TRANSFORMATION EXCEPTIONS
      // the transformer does not propagate source channels which are stored in Subject.jsonProperties.Subject.Job
      if (sourceElem instanceof Subject) {
        if (sourceElem.jsonProperties?.Subject?.Job) {
          if (!expectedSourceElemJsonProps.Subject)
            expectedSourceElemJsonProps.Subject = {};
          expectedSourceElemJsonProps.Subject.Job = undefined;
        }
      }
      if (sourceElem instanceof DisplayStyle3d) {
        const styles = expectedSourceElemJsonProps.styles as
          | DisplayStyle3dSettingsProps
          | undefined;
        if (styles?.environment?.sky) {
          const sky = styles.environment.sky;
          if (!sky.image)
            sky.image = { type: SkyBoxImageType.None } as SkyBoxImageProps;

          const image = sky.image;
          if (image?.texture === Id64.invalid)
            (image.texture as string | undefined) = undefined;

          if (image?.texture) image.texture = remapElem(image.texture);

          if (!sky.twoColor)
            expectedSourceElemJsonProps.styles.environment.sky.twoColor = false;

          if ((sky as any).file === "") delete (sky as any).file;
        }

        const excludedElements =
          typeof styles?.excludedElements === "string"
            ? CompressedId64Set.decompressArray(styles.excludedElements)
            : styles?.excludedElements;

        for (let i = 0; i < (styles?.excludedElements?.length ?? 0); ++i) {
          const id = excludedElements![i];
          excludedElements![i] = remapElem(id);
        }

        for (const ovr of styles?.subCategoryOvr ?? []) {
          if (ovr.subCategory) ovr.subCategory = remapElem(ovr.subCategory);
        }
      }

      if (sourceElem instanceof SpatialViewDefinition) {
        const viewProps = expectedSourceElemJsonProps.viewDetails as
          | ViewDetails3dProps
          | undefined;
        if (viewProps && viewProps.acs)
          viewProps.acs = remapElem(viewProps.acs);
      }
      // END jsonProperties TRANSFORMATION EXCEPTIONS
      // kept for conditional breakpoints
      const _eq = TestUtils.advancedDeepEqual(
        expectedSourceElemJsonProps,
        targetElem.jsonProperties,
        { considerNonExistingAndUndefinedEqual: true }
      );
      expect(targetElem.jsonProperties).to.deep.advancedEqual(
        expectedSourceElemJsonProps,
        { considerNonExistingAndUndefinedEqual: true }
      );
    }

    for (const sourceAspect of sourceDb.elements.getAspects(sourceElemId)) {
      if (
        classesToIgnoreMissingEntitiesOfInTarget.some(
          (c) => sourceAspect instanceof c
        )
      )
        continue;
      const sourceAspectId = sourceAspect.id;
      const targetAspectId = remapAspect(sourceAspectId);
      const collectAllAspects = (elemId: string) => {
        let aspects = "";
        for (const targetElemAspect of targetDb.elements.getAspects(elemId)) {
          aspects += `\t${JSON.stringify(targetElemAspect)}\n\n`;
        }
        return aspects;
      };
      expect(
        targetAspectId,
        [
          `Expected sourceAspect:\n\t ${JSON.stringify(sourceAspect)}`,
          `on sourceElement:\n\t ${JSON.stringify(sourceElem)}`,
          `with targetElement:\n\t ${JSON.stringify(targetElem)}`,
          "to have a corresponding targetAspectId that wasn't invalid.",
          `targetElement's aspects:\n${collectAllAspects(targetElemId)}`,
        ].join("\n")
      ).not.to.equal(Id64.invalid);
      const targetAspect = targetDb.elements.getAspect(targetAspectId);
      expect(targetAspect).not.to.be.undefined;
    }
  }

  // eslint-disable-next-line deprecation/deprecation
  for await (const [targetElemId] of targetDb.query(
    "SELECT ECInstanceId FROM bis.Element"
  )) {
    if (!targetElemIds.has(targetElemId)) {
      const targetElem = targetDb.elements.getElement(targetElemId);
      targetToSourceElemsMap.set(targetElem, undefined);
    }
  }

  const onlyInSourceElements = new Map(
    [...sourceToTargetElemsMap]
      .filter(([_inSource, inTarget]) => inTarget === undefined)
      .map(([inSource]) => [inSource.id, inSource])
  );
  const onlyInTargetElements = new Map(
    [...targetToSourceElemsMap]
      .filter(([_inTarget, inSource]) => inSource === undefined)
      .map(([inTarget]) => [inTarget.id, inTarget])
  );

  const makeElemsInvariant = (elems: Partial<Element>[]) =>
    elems
      .filter(
        (elem) =>
          !classesToIgnoreMissingEntitiesOfInTarget.some(
            (cls) => elem instanceof cls
          )
      )
      .map((elem) => {
        const rawProps = { ...elem } as Partial<Mutable<Element>>;
        delete rawProps.iModel;
        delete rawProps.id;
        delete rawProps.isInstanceOfEntity;
        return rawProps;
      });

  const elementsOnlyInSourceAsInvariant = makeElemsInvariant([
    ...onlyInSourceElements.values(),
  ]);
  const elementsOnlyInTargetAsInvariant = makeElemsInvariant([
    ...onlyInTargetElements.values(),
  ]);

  expect(elementsOnlyInSourceAsInvariant).to.deep.equal(
    expectedElemsOnlyInSource
  );
  expect(elementsOnlyInTargetAsInvariant).to.deep.equal(
    expectedElemsOnlyInTarget
  );

  const sourceToTargetModelsMap = new Map<Model, Model | undefined>();
  const targetToSourceModelsMap = new Map<Model, Model | undefined>();
  const targetModelIds = new Set<Id64String>();

  // eslint-disable-next-line deprecation/deprecation
  for await (const [sourceModelId] of sourceDb.query(
    "SELECT ECInstanceId FROM bis.Model"
  )) {
    const targetModelId = remapElem(sourceModelId);
    const sourceModel = sourceDb.models.getModel(sourceModelId);
    const targetModel = targetDb.models.tryGetModel(targetModelId);
    // expect(targetModel.toExist)
    sourceToTargetModelsMap.set(sourceModel, targetModel);
    if (targetModel) {
      targetModelIds.add(targetModelId);
      targetToSourceModelsMap.set(targetModel, sourceModel);
      const expectedSourceModelJsonProps = { ...sourceModel.jsonProperties };
      const _eq = TestUtils.advancedDeepEqual(
        expectedSourceModelJsonProps,
        targetModel.jsonProperties
      );
      expect(targetModel.jsonProperties).to.deep.advancedEqual(
        expectedSourceModelJsonProps
      );
    }
  }

  // eslint-disable-next-line deprecation/deprecation
  for await (const [targetModelId] of targetDb.query(
    "SELECT ECInstanceId FROM bis.Model"
  )) {
    if (!targetModelIds.has(targetModelId)) {
      const targetModel = targetDb.models.getModel(targetModelId);
      targetToSourceModelsMap.set(targetModel, undefined);
    }
  }

  const onlyInSourceModels = [...sourceToTargetModelsMap]
    .filter(([_inSource, inTarget]) => inTarget === undefined)
    .map(([inSource]) => inSource);
  const onlyInTargetModels = [...targetToSourceModelsMap]
    .filter(([_inTarget, inSource]) => inSource === undefined)
    .map(([inTarget]) => inTarget);
  const modelsOnlyInSourceAsInvariant = onlyInSourceModels.map((elem) => {
    const rawProps = { ...elem } as Partial<Mutable<Model>>;
    delete rawProps.iModel;
    delete rawProps.id;
    delete rawProps.isInstanceOfEntity;
    return rawProps;
  });

  expect(modelsOnlyInSourceAsInvariant).to.have.length(0);
  expect(onlyInTargetModels).to.have.length(0);

  const makeRelationKey = (rel: any) =>
    `${rel.SourceECInstanceId}\x00${rel.TargetECInstanceId}`;
  const query: Parameters<IModelDb["query"]> = [
    "SELECT * FROM bis.ElementRefersToElements",
    undefined,
    { rowFormat: QueryRowFormat.UseECSqlPropertyNames },
  ];
  const sourceRelationships = new Map<string, any>();
  // eslint-disable-next-line deprecation/deprecation
  for await (const row of sourceDb.query(...query)) {
    sourceRelationships.set(makeRelationKey(row), row);
  }

  const targetRelationshipsToFind = new Map<string, any>();
  // eslint-disable-next-line deprecation/deprecation
  for await (const row of targetDb.query(...query)) {
    targetRelationshipsToFind.set(makeRelationKey(row), row);
  }

  /* eslint-disable @typescript-eslint/naming-convention */
  for (const relInSource of sourceRelationships.values()) {
    const isOnlyInSource =
      onlyInSourceElements.has(relInSource.SourceECInstanceId) &&
      onlyInSourceElements.has(relInSource.TargetECInstanceId);
    if (isOnlyInSource) continue;

    const relSourceInTarget = remapElem(relInSource.SourceECInstanceId);
    expect(relSourceInTarget).to.not.equal(Id64.invalid);
    const relTargetInTarget = remapElem(relInSource.TargetECInstanceId);
    expect(relTargetInTarget).to.not.equal(Id64.invalid);
    const relInTargetKey = makeRelationKey({
      SourceECInstanceId: relSourceInTarget,
      TargetECInstanceId: relTargetInTarget,
    });
    const relInTarget = targetRelationshipsToFind.get(relInTargetKey);
    const relClassName = sourceDb.withPreparedStatement(
      "SELECT Name FROM meta.ECClassDef WHERE ECInstanceId=?",
      (s) => {
        s.bindId(1, relInSource.ECClassId);
        s.step();
        return s.getValue(0).getString();
      }
    );
    expect(
      relInTarget,
      `rel ${relClassName}:${relInSource.SourceECInstanceId}->${relInSource.TargetECInstanceId} was missing`
    ).not.to.be.undefined;
    // this won't work if the relationship instance has navigation properties (or any property that was changed by the transformer)
    const makeRelInvariant = ({
      SourceECInstanceId: _1,
      TargetECInstanceId: _2,
      ECClassId: _3,
      ECInstanceId: _4,
      SourceECClassId: _5,
      TargetECClassId: _6,
      ...rel
    }: any) => rel;
    expect(makeRelInvariant(relInSource)).to.deep.equal(
      makeRelInvariant(relInTarget)
    );
    targetRelationshipsToFind.delete(relInTargetKey);
  }
  /* eslint-enable @typescript-eslint/naming-convention */

  expect(targetRelationshipsToFind.size).to.equal(0);
}

export class TransformerExtensiveTestScenario extends TestUtils.ExtensiveTestScenario {
  public static async prepareTargetDb(targetDb: IModelDb): Promise<void> {
    // Import desired target schemas
    const targetSchemaFileName: string = path.join(
      KnownTestLocations.assetsDir,
      "ExtensiveTestScenarioTarget.ecschema.xml"
    );
    await targetDb.importSchemas([targetSchemaFileName]);
    // Insert a target-only CodeSpec to test remapping
    const targetCodeSpecId: Id64String = targetDb.codeSpecs.insert(
      "TargetCodeSpec",
      CodeScopeSpec.Type.Model
    );
    assert.isTrue(Id64.isValidId64(targetCodeSpecId));
    // Insert some elements to avoid getting same IDs for sourceDb and targetDb
    const subjectId = Subject.insert(
      targetDb,
      IModel.rootSubjectId,
      "Only in Target"
    );
    Subject.insert(targetDb, subjectId, "S1");
    Subject.insert(targetDb, subjectId, "S2");
    Subject.insert(targetDb, subjectId, "S3");
    Subject.insert(targetDb, subjectId, "S4");
    const targetPhysicalCategoryId =
      IModelTransformerTestUtils.insertSpatialCategory(
        targetDb,
        IModel.dictionaryId,
        "TargetPhysicalCategory",
        ColorDef.red
      );
    assert.isTrue(Id64.isValidId64(targetPhysicalCategoryId));
  }

  public static assertTargetDbContents(
    sourceDb: IModelDb,
    targetDb: IModelDb,
    options?: { expectEsas?: boolean; targetSubjectName?: string }
  ): void {
    const expectEsas = options?.expectEsas ?? false;
    const targetSubjectName = options?.targetSubjectName ?? "Subject";
    const assertTargetElement = (targetElementId: Id64String) => {
      assert.isTrue(Id64.isValidId64(targetElementId));
      const element: Element = targetDb.elements.getElement(targetElementId);
      assert.isTrue(
        element.federationGuid && Guid.isV4Guid(element.federationGuid)
      );
      const aspects = targetDb.elements.getAspects(
        targetElementId,
        ExternalSourceAspect.classFullName
      );
      expect(
        aspects.some(
          (esa: any) => esa.kind === ExternalSourceAspect.Kind.Element
        )
      ).to.be.equal(expectEsas);
    };

    // CodeSpec
    assert.isTrue(targetDb.codeSpecs.hasName("TargetCodeSpec"));
    assert.isTrue(targetDb.codeSpecs.hasName("InformationRecords"));
    assert.isFalse(targetDb.codeSpecs.hasName("SourceCodeSpec"));
    assert.isFalse(targetDb.codeSpecs.hasName("ExtraCodeSpec"));

    // Font
    assert.exists(targetDb.fontMap.getFont("Arial"));
    // Subject
    const subjectId: Id64String = targetDb.elements.queryElementIdByCode(
      Subject.createCode(targetDb, IModel.rootSubjectId, targetSubjectName)
    )!;
    assert.isTrue(Id64.isValidId64(subjectId));
    const subjectProps: SubjectProps =
      targetDb.elements.getElementProps(subjectId);
    assert.equal(subjectProps.description, `${targetSubjectName} Description`);
    const sourceOnlySubjectId = targetDb.elements.queryElementIdByCode(
      Subject.createCode(targetDb, IModel.rootSubjectId, "Only in Source")
    );
    assert.equal(undefined, sourceOnlySubjectId);
    const targetOnlySubjectId = targetDb.elements.queryElementIdByCode(
      Subject.createCode(targetDb, IModel.rootSubjectId, "Only in Target")
    )!;
    assert.isTrue(Id64.isValidId64(targetOnlySubjectId));
    // Partitions / Models
    const definitionModelId = targetDb.elements.queryElementIdByCode(
      InformationPartitionElement.createCode(targetDb, subjectId, "Definition")
    )!;
    const informationModelId = targetDb.elements.queryElementIdByCode(
      InformationPartitionElement.createCode(targetDb, subjectId, "Information")
    )!;
    const groupModelId = targetDb.elements.queryElementIdByCode(
      InformationPartitionElement.createCode(targetDb, subjectId, "Group")
    )!;
    const physicalModelId = targetDb.elements.queryElementIdByCode(
      InformationPartitionElement.createCode(targetDb, subjectId, "Physical")
    )!;
    const spatialLocationModelId = targetDb.elements.queryElementIdByCode(
      InformationPartitionElement.createCode(
        targetDb,
        subjectId,
        "SpatialLocation"
      )
    )!;
    const documentListModelId = targetDb.elements.queryElementIdByCode(
      InformationPartitionElement.createCode(targetDb, subjectId, "Document")
    )!;
    assertTargetElement(definitionModelId);
    assertTargetElement(informationModelId);
    assertTargetElement(groupModelId);
    assertTargetElement(physicalModelId);
    assertTargetElement(spatialLocationModelId);
    assertTargetElement(documentListModelId);
    const physicalModel: PhysicalModel =
      targetDb.models.getModel<PhysicalModel>(physicalModelId);
    const spatialLocationModel: SpatialLocationModel =
      targetDb.models.getModel<SpatialLocationModel>(spatialLocationModelId);
    assert.isFalse(physicalModel.isPlanProjection);
    assert.isTrue(spatialLocationModel.isPlanProjection);
    // SpatialCategory
    const spatialCategoryId = targetDb.elements.queryElementIdByCode(
      SpatialCategory.createCode(targetDb, definitionModelId, "SpatialCategory")
    )!;
    assertTargetElement(spatialCategoryId);
    const spatialCategoryProps =
      targetDb.elements.getElementProps(spatialCategoryId);
    assert.equal(definitionModelId, spatialCategoryProps.model);
    assert.equal(definitionModelId, spatialCategoryProps.code.scope);
    assert.equal(
      undefined,
      targetDb.elements.queryElementIdByCode(
        SpatialCategory.createCode(
          targetDb,
          definitionModelId,
          "SourcePhysicalCategory"
        )
      ),
      "Should have been remapped"
    );
    const targetPhysicalCategoryId = targetDb.elements.queryElementIdByCode(
      SpatialCategory.createCode(
        targetDb,
        IModel.dictionaryId,
        "TargetPhysicalCategory"
      )
    )!;
    assert.isTrue(Id64.isValidId64(targetPhysicalCategoryId));
    // SubCategory
    const subCategoryId = targetDb.elements.queryElementIdByCode(
      SubCategory.createCode(targetDb, spatialCategoryId, "SubCategory")
    )!;
    assertTargetElement(subCategoryId);
    const filteredSubCategoryId = targetDb.elements.queryElementIdByCode(
      SubCategory.createCode(targetDb, spatialCategoryId, "FilteredSubCategory")
    );
    assert.isUndefined(filteredSubCategoryId);
    // DrawingCategory
    const drawingCategoryId = targetDb.elements.queryElementIdByCode(
      DrawingCategory.createCode(targetDb, definitionModelId, "DrawingCategory")
    )!;
    assertTargetElement(drawingCategoryId);
    const drawingCategoryProps =
      targetDb.elements.getElementProps(drawingCategoryId);
    assert.equal(definitionModelId, drawingCategoryProps.model);
    assert.equal(definitionModelId, drawingCategoryProps.code.scope);
    // Spatial CategorySelector
    const spatialCategorySelectorId = targetDb.elements.queryElementIdByCode(
      CategorySelector.createCode(
        targetDb,
        definitionModelId,
        "SpatialCategories"
      )
    )!;
    assertTargetElement(spatialCategorySelectorId);
    const spatialCategorySelectorProps =
      targetDb.elements.getElementProps<CategorySelectorProps>(
        spatialCategorySelectorId
      );
    assert.isTrue(
      spatialCategorySelectorProps.categories.includes(spatialCategoryId)
    );
    assert.isTrue(
      spatialCategorySelectorProps.categories.includes(
        targetPhysicalCategoryId
      ),
      "SourcePhysicalCategory should have been remapped to TargetPhysicalCategory"
    );
    // Drawing CategorySelector
    const drawingCategorySelectorId = targetDb.elements.queryElementIdByCode(
      CategorySelector.createCode(
        targetDb,
        definitionModelId,
        "DrawingCategories"
      )
    )!;
    assertTargetElement(drawingCategorySelectorId);
    const drawingCategorySelectorProps =
      targetDb.elements.getElementProps<CategorySelectorProps>(
        drawingCategorySelectorId
      );
    assert.isTrue(
      drawingCategorySelectorProps.categories.includes(drawingCategoryId)
    );
    // ModelSelector
    const modelSelectorId = targetDb.elements.queryElementIdByCode(
      ModelSelector.createCode(targetDb, definitionModelId, "SpatialModels")
    )!;
    assertTargetElement(modelSelectorId);
    const modelSelectorProps =
      targetDb.elements.getElementProps<ModelSelectorProps>(modelSelectorId);
    assert.isTrue(modelSelectorProps.models.includes(physicalModelId));
    assert.isTrue(modelSelectorProps.models.includes(spatialLocationModelId));
    // Texture
    const textureId = targetDb.elements.queryElementIdByCode(
      Texture.createCode(targetDb, definitionModelId, "Texture")
    )!;
    assert.isTrue(Id64.isValidId64(textureId));
    // RenderMaterial
    const renderMaterialId = targetDb.elements.queryElementIdByCode(
      RenderMaterialElement.createCode(
        targetDb,
        definitionModelId,
        "RenderMaterial"
      )
    )!;
    assert.isTrue(Id64.isValidId64(renderMaterialId));
    // GeometryPart
    const geometryPartId = targetDb.elements.queryElementIdByCode(
      GeometryPart.createCode(targetDb, definitionModelId, "GeometryPart")
    )!;
    assert.isTrue(Id64.isValidId64(geometryPartId));
    // PhysicalElement
    const physicalObjectId1: Id64String =
      IModelTransformerTestUtils.queryByUserLabel(targetDb, "PhysicalObject1");
    const physicalObjectId2: Id64String =
      IModelTransformerTestUtils.queryByUserLabel(targetDb, "PhysicalObject2");
    const physicalObjectId3: Id64String =
      IModelTransformerTestUtils.queryByUserLabel(targetDb, "PhysicalObject3");
    const physicalObjectId4: Id64String =
      IModelTransformerTestUtils.queryByUserLabel(targetDb, "PhysicalObject4");
    const physicalElementId1: Id64String =
      IModelTransformerTestUtils.queryByUserLabel(targetDb, "PhysicalElement1");
    const childObjectId1A: Id64String =
      IModelTransformerTestUtils.queryByUserLabel(targetDb, "ChildObject1A");
    const childObjectId1B: Id64String =
      IModelTransformerTestUtils.queryByUserLabel(targetDb, "ChildObject1B");
    assertTargetElement(physicalObjectId1);
    assertTargetElement(physicalObjectId2);
    assertTargetElement(physicalObjectId3);
    assertTargetElement(physicalObjectId4);
    assertTargetElement(physicalElementId1);
    assertTargetElement(childObjectId1A);
    assertTargetElement(childObjectId1B);
    const physicalObject1: PhysicalObject =
      targetDb.elements.getElement<PhysicalObject>({
        id: physicalObjectId1,
        wantGeometry: true,
      });
    const physicalObject2: PhysicalObject =
      targetDb.elements.getElement<PhysicalObject>(physicalObjectId2);
    const physicalObject3: PhysicalObject =
      targetDb.elements.getElement<PhysicalObject>(physicalObjectId3);
    const physicalObject4: PhysicalObject =
      targetDb.elements.getElement<PhysicalObject>({
        id: physicalObjectId4,
        wantGeometry: true,
      });
    const physicalElement1: PhysicalElement =
      targetDb.elements.getElement<PhysicalElement>(physicalElementId1);
    const childObject1A: PhysicalObject =
      targetDb.elements.getElement<PhysicalObject>(childObjectId1A);
    const childObject1B: PhysicalObject =
      targetDb.elements.getElement<PhysicalObject>(childObjectId1B);
    assert.equal(
      physicalObject1.category,
      spatialCategoryId,
      "SpatialCategory should have been imported"
    );
    assert.isDefined(physicalObject1.geom);
    let index1 = 0;
    for (const entry of new GeometryStreamIterator(physicalObject1.geom!)) {
      if (0 === index1) {
        assert.equal(entry.primitive.type, "geometryQuery");
        assert.equal(entry.geomParams.subCategoryId, subCategoryId);
        assert.equal(entry.geomParams.materialId, renderMaterialId);
      } else if (1 === index1) {
        assert.equal(entry.primitive.type, "partReference");
        assert.equal(entry.geomParams.subCategoryId, subCategoryId);
        assert.equal(entry.geomParams.materialId, renderMaterialId);
        if (entry.primitive.type === "partReference")
          assert.equal(entry.primitive.part.id, geometryPartId);
      } else {
        assert.fail(undefined, undefined, "Only expected 2 entries");
      }
      index1++;
    }
    assert.equal(
      physicalObject2.category,
      targetPhysicalCategoryId,
      "SourcePhysicalCategory should have been remapped to TargetPhysicalCategory"
    );
    assert.equal(
      physicalObject3.federationGuid,
      TestUtils.ExtensiveTestScenario.federationGuid3,
      "Source FederationGuid should have been transferred to target element"
    );
    assert.equal(physicalObject4.category, spatialCategoryId);
    let index4 = 0;
    for (const entry of new GeometryStreamIterator(physicalObject4.geom!)) {
      assert.equal(entry.primitive.type, "geometryQuery");
      if (0 === index4) {
        assert.notEqual(
          entry.geomParams.subCategoryId,
          subCategoryId,
          "Expect the default SubCategory"
        );
      } else if (1 === index4) {
        assert.equal(entry.geomParams.subCategoryId, subCategoryId);
      }
      index4++;
    }
    assert.equal(
      index4,
      2,
      "Expect 2 remaining boxes since 1 was filtered out"
    );
    assert.equal(
      physicalElement1.category,
      targetPhysicalCategoryId,
      "SourcePhysicalCategory should have been remapped to TargetPhysicalCategory"
    );
    assert.equal(
      physicalElement1.classFullName,
      "ExtensiveTestScenarioTarget:TargetPhysicalElement",
      "Class should have been remapped"
    );
    assert.equal(
      physicalElement1.asAny.targetString,
      "S1",
      "Property should have been remapped by onTransformElement override"
    );
    assert.equal(
      physicalElement1.asAny.targetDouble,
      1.1,
      "Property should have been remapped by onTransformElement override"
    );
    assert.equal(
      physicalElement1.asAny.targetNavigation.id,
      targetPhysicalCategoryId,
      "Property should have been remapped by onTransformElement override"
    );
    assert.equal(
      physicalElement1.asAny.commonNavigation.id,
      targetPhysicalCategoryId,
      "Property should have been automatically remapped (same name)"
    );
    assert.equal(
      physicalElement1.asAny.commonString,
      "Common",
      "Property should have been automatically remapped (same name)"
    );
    assert.equal(
      physicalElement1.asAny.commonDouble,
      7.3,
      "Property should have been automatically remapped (same name)"
    );
    assert.equal(
      Base64EncodedString.fromUint8Array(physicalElement1.asAny.targetBinary),
      Base64EncodedString.fromUint8Array(new Uint8Array([1, 3, 5, 7])),
      "Property should have been remapped by onTransformElement override"
    );
    assert.equal(
      Base64EncodedString.fromUint8Array(physicalElement1.asAny.commonBinary),
      Base64EncodedString.fromUint8Array(new Uint8Array([2, 4, 6, 8])),
      "Property should have been automatically remapped (same name)"
    );
    assert.notExists(
      physicalElement1.asAny.extraString,
      "Property should have been dropped during transformation"
    );
    assert.equal(childObject1A.parent!.id, physicalObjectId1);
    assert.equal(childObject1B.parent!.id, physicalObjectId1);
    // ElementUniqueAspects
    const targetUniqueAspects: ElementAspect[] = targetDb.elements.getAspects(
      physicalObjectId1,
      "ExtensiveTestScenarioTarget:TargetUniqueAspect"
    );
    assert.equal(targetUniqueAspects.length, 1);
    assert.equal(targetUniqueAspects[0].asAny.commonDouble, 1.1);
    assert.equal(targetUniqueAspects[0].asAny.commonString, "Unique");
    assert.equal(
      targetUniqueAspects[0].asAny.commonLong,
      physicalObjectId1,
      "Id should have been remapped"
    );
    assert.equal(
      Base64EncodedString.fromUint8Array(
        targetUniqueAspects[0].asAny.commonBinary
      ),
      Base64EncodedString.fromUint8Array(new Uint8Array([2, 4, 6, 8]))
    );
    assert.equal(targetUniqueAspects[0].asAny.targetDouble, 11.1);
    assert.equal(targetUniqueAspects[0].asAny.targetString, "UniqueAspect");
    assert.equal(
      targetUniqueAspects[0].asAny.targetLong,
      physicalObjectId1,
      "Id should have been remapped"
    );
    assert.isTrue(Guid.isV4Guid(targetUniqueAspects[0].asAny.targetGuid));
    assert.equal(
      TestUtils.ExtensiveTestScenario.uniqueAspectGuid,
      targetUniqueAspects[0].asAny.targetGuid
    );
    // ElementMultiAspects
    const targetMultiAspects: ElementAspect[] = targetDb.elements.getAspects(
      physicalObjectId1,
      "ExtensiveTestScenarioTarget:TargetMultiAspect"
    );
    assert.equal(targetMultiAspects.length, 2);
    assert.equal(targetMultiAspects[0].asAny.commonDouble, 2.2);
    assert.equal(targetMultiAspects[0].asAny.commonString, "Multi");
    assert.equal(
      targetMultiAspects[0].asAny.commonLong,
      physicalObjectId1,
      "Id should have been remapped"
    );
    assert.equal(targetMultiAspects[0].asAny.targetDouble, 22.2);
    assert.equal(targetMultiAspects[0].asAny.targetString, "MultiAspect");
    assert.equal(
      targetMultiAspects[0].asAny.targetLong,
      physicalObjectId1,
      "Id should have been remapped"
    );
    assert.isTrue(Guid.isV4Guid(targetMultiAspects[0].asAny.targetGuid));
    assert.equal(targetMultiAspects[1].asAny.commonDouble, 3.3);
    assert.equal(targetMultiAspects[1].asAny.commonString, "Multi");
    assert.equal(
      targetMultiAspects[1].asAny.commonLong,
      physicalObjectId1,
      "Id should have been remapped"
    );
    assert.equal(targetMultiAspects[1].asAny.targetDouble, 33.3);
    assert.equal(targetMultiAspects[1].asAny.targetString, "MultiAspect");
    assert.equal(
      targetMultiAspects[1].asAny.targetLong,
      physicalObjectId1,
      "Id should have been remapped"
    );
    assert.isTrue(Guid.isV4Guid(targetMultiAspects[1].asAny.targetGuid));
    // InformationRecords
    const informationRecordCodeSpec: CodeSpec =
      targetDb.codeSpecs.getByName("InformationRecords");
    assert.isTrue(Id64.isValidId64(informationRecordCodeSpec.id));
    const informationRecordId1 = targetDb.elements.queryElementIdByCode(
      new Code({
        spec: informationRecordCodeSpec.id,
        scope: informationModelId,
        value: "InformationRecord1",
      })
    );
    const informationRecordId2 = targetDb.elements.queryElementIdByCode(
      new Code({
        spec: informationRecordCodeSpec.id,
        scope: informationModelId,
        value: "InformationRecord2",
      })
    );
    const informationRecordId3 = targetDb.elements.queryElementIdByCode(
      new Code({
        spec: informationRecordCodeSpec.id,
        scope: informationModelId,
        value: "InformationRecord3",
      })
    );
    assert.isTrue(Id64.isValidId64(informationRecordId1!));
    assert.isTrue(Id64.isValidId64(informationRecordId2!));
    assert.isTrue(Id64.isValidId64(informationRecordId3!));
    const informationRecord2: any = targetDb.elements.getElement(
      informationRecordId2!
    );
    assert.equal(informationRecord2.commonString, "Common2");
    assert.equal(informationRecord2.targetString, "Two");
    // DisplayStyle
    const displayStyle3dId = targetDb.elements.queryElementIdByCode(
      DisplayStyle3d.createCode(targetDb, definitionModelId, "DisplayStyle3d")
    )!;
    assertTargetElement(displayStyle3dId);
    const displayStyle3d =
      targetDb.elements.getElement<DisplayStyle3d>(displayStyle3dId);
    assert.isTrue(displayStyle3d.settings.hasSubCategoryOverride);
    assert.equal(displayStyle3d.settings.subCategoryOverrides.size, 1);
    assert.exists(
      displayStyle3d.settings.getSubCategoryOverride(subCategoryId),
      "Expect subCategoryOverrides to have been remapped"
    );
    assert.isTrue(
      new Set<string>(displayStyle3d.settings.excludedElementIds).has(
        physicalObjectId1
      ),
      "Expect excludedElements to be remapped"
    );
    assert.equal(
      displayStyle3d.settings.environment.sky.toJSON()?.image?.type,
      SkyBoxImageType.Spherical
    );
    assert.equal(
      displayStyle3d.settings.environment.sky.toJSON()?.image?.texture,
      textureId
    );
    assert.equal(
      displayStyle3d.settings.getPlanProjectionSettings(spatialLocationModelId)
        ?.elevation,
      10.0
    );
    // ViewDefinition
    const viewId = targetDb.elements.queryElementIdByCode(
      OrthographicViewDefinition.createCode(
        targetDb,
        definitionModelId,
        "Orthographic View"
      )
    )!;
    assertTargetElement(viewId);
    const viewProps =
      targetDb.elements.getElementProps<SpatialViewDefinitionProps>(viewId);
    assert.equal(viewProps.displayStyleId, displayStyle3dId);
    assert.equal(viewProps.categorySelectorId, spatialCategorySelectorId);
    assert.equal(viewProps.modelSelectorId, modelSelectorId);
    // AuxCoordSystem2d
    assert.equal(
      undefined,
      targetDb.elements.queryElementIdByCode(
        AuxCoordSystem2d.createCode(
          targetDb,
          definitionModelId,
          "AuxCoordSystem2d"
        )
      ),
      "Should have been excluded by class"
    );
    // DrawingGraphic
    const drawingGraphicId1: Id64String =
      IModelTransformerTestUtils.queryByUserLabel(targetDb, "DrawingGraphic1");
    const drawingGraphicId2: Id64String =
      IModelTransformerTestUtils.queryByUserLabel(targetDb, "DrawingGraphic2");
    assertTargetElement(drawingGraphicId1);
    assertTargetElement(drawingGraphicId2);
    // DrawingGraphicRepresentsElement
    TransformerExtensiveTestScenario.assertTargetRelationship(
      sourceDb,
      targetDb,
      DrawingGraphicRepresentsElement.classFullName,
      drawingGraphicId1,
      physicalObjectId1,
      expectEsas
    );
    TransformerExtensiveTestScenario.assertTargetRelationship(
      sourceDb,
      targetDb,
      DrawingGraphicRepresentsElement.classFullName,
      drawingGraphicId2,
      physicalObjectId1,
      expectEsas
    );
    // TargetRelWithProps
    const relWithProps: any = targetDb.relationships.getInstanceProps(
      "ExtensiveTestScenarioTarget:TargetRelWithProps",
      {
        sourceId: spatialCategorySelectorId,
        targetId: drawingCategorySelectorId,
      }
    );
    assert.equal(relWithProps.targetString, "One");
    assert.equal(relWithProps.targetDouble, 1.1);
    assert.equal(relWithProps.targetLong, spatialCategoryId);
    assert.isTrue(Guid.isV4Guid(relWithProps.targetGuid));
  }

  public static assertTargetRelationship(
    _sourceDb: IModelDb,
    targetDb: IModelDb,
    targetRelClassFullName: string,
    targetRelSourceId: Id64String,
    targetRelTargetId: Id64String,
    expectEsas: boolean = false
  ): void {
    const targetRelationship: Relationship = targetDb.relationships.getInstance(
      targetRelClassFullName,
      { sourceId: targetRelSourceId, targetId: targetRelTargetId }
    );
    assert.exists(targetRelationship);
    const aspects: ElementAspect[] = targetDb.elements.getAspects(
      targetRelSourceId,
      ExternalSourceAspect.classFullName
    );
    expect(
      aspects.some(
        (esa: any) => esa.kind === ExternalSourceAspect.Kind.Relationship
      )
    ).to.be.equal(expectEsas);
  }
}

/** Test IModelTransformer that applies a 3d transform to all GeometricElement3d instances. */
export class IModelTransformer3d extends IModelTransformer {
  /** The Transform to apply to all GeometricElement3d instances. */
  private readonly _transform3d: Transform;
  /** Construct a new IModelTransformer3d */
  public constructor(
    sourceDb: IModelDb,
    targetDb: IModelDb,
    transform3d: Transform
  ) {
    super(sourceDb, targetDb);
    this._transform3d = transform3d;
  }
  /** Override transformElement to apply a 3d transform to all GeometricElement3d instances. */
  public override onTransformElement(sourceElement: Element): ElementProps {
    const targetElementProps: ElementProps = super.onTransformElement(
      sourceElement
    );
    if (sourceElement instanceof GeometricElement3d) {
      // can check the sourceElement since this IModelTransformer does not remap classes
      const placement = Placement3d.fromJSON(
        (targetElementProps as GeometricElement3dProps).placement
      );
      if (placement.isValid) {
        placement.multiplyTransform(this._transform3d);
        (targetElementProps as GeometricElement3dProps).placement = placement;
      }
    }
    return targetElementProps;
  }
}

/** Test IModelTransformer that consolidates all PhysicalModels into one. */
export class PhysicalModelConsolidator extends IModelTransformer {
  /** Remap all source PhysicalModels to this one. */
  private readonly _targetModelId: Id64String;
  /** Construct a new PhysicalModelConsolidator */
  public constructor(
    sourceDb: IModelDb,
    targetDb: IModelDb,
    targetModelId: Id64String,
    argsForProcessChanges?: ProcessChangesOptions
  ) {
    super(sourceDb, targetDb, {
      argsForProcessChanges,
    });
    this._targetModelId = targetModelId;
    this.importer.doNotUpdateElementIds.add(targetModelId);
  }
  /** Override shouldExportElement to remap PhysicalPartition instances. */
  public override shouldExportElement(sourceElement: Element): boolean {
    if (sourceElement instanceof PhysicalPartition) {
      this.combineElements([sourceElement.id], this._targetModelId);
      // NOTE: must allow export to continue so the PhysicalModel sub-modeling the PhysicalPartition is processed
    }
    return super.shouldExportElement(sourceElement);
  }
}

/** Test IModelTransformer that uses a SpatialViewDefinition to filter the iModel contents. */
export class FilterByViewTransformer extends IModelTransformer {
  private readonly _exportViewDefinitionId: Id64String;
  private readonly _exportModelSelectorId: Id64String;
  private readonly _exportCategorySelectorId: Id64String;
  private readonly _exportDisplayStyleId: Id64String;
  private readonly _exportModelIds: Id64Set;
  public constructor(
    sourceDb: IModelDb,
    targetDb: IModelDb,
    exportViewDefinitionId: Id64String
  ) {
    super(sourceDb, targetDb);
    this._exportViewDefinitionId = exportViewDefinitionId;
    const exportViewDefinition =
      sourceDb.elements.getElement<SpatialViewDefinition>(
        exportViewDefinitionId,
        SpatialViewDefinition
      );
    this._exportCategorySelectorId = exportViewDefinition.categorySelectorId;
    this._exportModelSelectorId = exportViewDefinition.modelSelectorId;
    this._exportDisplayStyleId = exportViewDefinition.displayStyleId;
    const exportCategorySelector =
      sourceDb.elements.getElement<CategorySelector>(
        exportViewDefinition.categorySelectorId,
        CategorySelector
      );
    this.excludeCategoriesExcept(
      Id64.toIdSet(exportCategorySelector.categories)
    );
    const exportModelSelector = sourceDb.elements.getElement<ModelSelector>(
      exportViewDefinition.modelSelectorId,
      ModelSelector
    );
    this._exportModelIds = Id64.toIdSet(exportModelSelector.models);
  }
  /** Excludes categories not referenced by the export view's CategorySelector */
  private excludeCategoriesExcept(exportCategoryIds: Id64Set): void {
    const sql = `SELECT ECInstanceId FROM ${SpatialCategory.classFullName}`;
    this.sourceDb.withPreparedStatement(
      sql,
      (statement: ECSqlStatement): void => {
        while (DbResult.BE_SQLITE_ROW === statement.step()) {
          const categoryId = statement.getValue(0).getId();
          if (!exportCategoryIds.has(categoryId)) {
            this.exporter.excludeElementsInCategory(categoryId);
          }
        }
      }
    );
  }
  /** Override of IModelTransformer.shouldExportElement that excludes other ViewDefinition-related elements that are not associated with the *export* ViewDefinition. */
  public override shouldExportElement(sourceElement: Element): boolean {
    if (sourceElement instanceof PhysicalPartition) {
      return this._exportModelIds.has(sourceElement.id);
    } else if (sourceElement instanceof SpatialViewDefinition) {
      return sourceElement.id === this._exportViewDefinitionId;
    } else if (sourceElement instanceof CategorySelector) {
      return sourceElement.id === this._exportCategorySelectorId;
    } else if (sourceElement instanceof ModelSelector) {
      return sourceElement.id === this._exportModelSelectorId;
    } else if (sourceElement instanceof DisplayStyle3d) {
      return sourceElement.id === this._exportDisplayStyleId;
    }
    return super.shouldExportElement(sourceElement);
  }
}

/**
 * Specialization of IModelTransformer for testing that remaps the extensive test scenario's comments
 * and records transformation data in the iModel itself.
 */
export class TestIModelTransformer extends IModelTransformer {
  public constructor(
    source: IModelDb | IModelExporter,
    target: IModelDb | IModelImporter,
    options?: IModelTransformOptions
  ) {
    super(source, target, options);
    this.initExclusions();
    this.initCodeSpecRemapping();
    this.initCategoryRemapping();
    this.initClassRemapping();
    this.initSubCategoryFilters();
  }

  /** Initialize some sample exclusion rules for testing */
  private initExclusions(): void {
    this.exporter.excludeCodeSpec("ExtraCodeSpec");
    this.exporter.excludeElementClass(AuxCoordSystem.classFullName); // want to exclude AuxCoordSystem2d/3d
    this.exporter.excludeElement(
      this.sourceDb.elements.queryElementIdByCode(
        Subject.createCode(
          this.sourceDb,
          IModel.rootSubjectId,
          "Only in Source"
        )
      )!
    );
    this.exporter.excludeRelationshipClass(
      "ExtensiveTestScenario:SourceRelToExclude"
    );
    this.exporter.excludeElementAspectClass(
      "ExtensiveTestScenario:SourceUniqueAspectToExclude"
    );
    this.exporter.excludeElementAspectClass(
      "ExtensiveTestScenario:SourceMultiAspectToExclude"
    );
  }

  /** Initialize some CodeSpec remapping rules for testing */
  private initCodeSpecRemapping(): void {
    this.context.remapCodeSpec("SourceCodeSpec", "TargetCodeSpec");
  }

  /** Initialize some category remapping rules for testing */
  private initCategoryRemapping(): void {
    const subjectId = this.sourceDb.elements.queryElementIdByCode(
      Subject.createCode(this.sourceDb, IModel.rootSubjectId, "Subject")
    )!;
    const definitionModelId = this.sourceDb.elements.queryElementIdByCode(
      InformationPartitionElement.createCode(
        this.sourceDb,
        subjectId,
        "Definition"
      )
    )!;
    const sourceCategoryId = this.sourceDb.elements.queryElementIdByCode(
      SpatialCategory.createCode(
        this.sourceDb,
        definitionModelId,
        "SourcePhysicalCategory"
      )
    )!;
    const targetCategoryId = this.targetDb.elements.queryElementIdByCode(
      SpatialCategory.createCode(
        this.targetDb,
        IModel.dictionaryId,
        "TargetPhysicalCategory"
      )
    )!;
    assert.isTrue(
      Id64.isValidId64(subjectId) &&
        Id64.isValidId64(definitionModelId) &&
        Id64.isValidId64(sourceCategoryId) &&
        Id64.isValidId64(targetCategoryId)
    );
    this.context.remapElement(sourceCategoryId, targetCategoryId);
    this.exporter.excludeElement(sourceCategoryId); // Don't process a specifically remapped element
  }

  /** Initialize some class remapping rules for testing */
  private initClassRemapping(): void {
    this.context.remapElementClass(
      "ExtensiveTestScenario:SourcePhysicalElement",
      "ExtensiveTestScenarioTarget:TargetPhysicalElement"
    );
    this.context.remapElementClass(
      "ExtensiveTestScenario:SourcePhysicalElementUsesCommonDefinition",
      "ExtensiveTestScenarioTarget:TargetPhysicalElementUsesCommonDefinition"
    );
    this.context.remapElementClass(
      "ExtensiveTestScenario:SourceInformationRecord",
      "ExtensiveTestScenarioTarget:TargetInformationRecord"
    );
  }

  /** */
  private initSubCategoryFilters(): void {
    assert.isFalse(this.context.hasSubCategoryFilter);
    const sql = `SELECT ECInstanceId FROM ${SubCategory.classFullName} WHERE CodeValue=:codeValue`;
    this.sourceDb.withPreparedStatement(
      sql,
      (statement: ECSqlStatement): void => {
        statement.bindString("codeValue", "FilteredSubCategory");
        while (DbResult.BE_SQLITE_ROW === statement.step()) {
          const subCategoryId = statement.getValue(0).getId();
          assert.isFalse(this.context.isSubCategoryFiltered(subCategoryId));
          this.context.filterSubCategory(subCategoryId);
          this.exporter.excludeElement(subCategoryId);
          assert.isTrue(this.context.isSubCategoryFiltered(subCategoryId));
        }
      }
    );
    assert.isTrue(this.context.hasSubCategoryFilter);
  }

  /** Override shouldExportElement to exclude all elements from the Functional schema. */
  public override shouldExportElement(sourceElement: Element): boolean {
    return sourceElement.classFullName.startsWith(FunctionalSchema.schemaName)
      ? false
      : super.shouldExportElement(sourceElement);
  }

  /** Override transformElement to make sure that all target Elements have a FederationGuid */
  public override onTransformElement(sourceElement: Element): ElementProps {
    const targetElementProps: any = super.onTransformElement(sourceElement);
    if (!targetElementProps.federationGuid) {
      targetElementProps.federationGuid = Guid.createValue();
    }
    if (
      "ExtensiveTestScenario:SourcePhysicalElement" ===
      sourceElement.classFullName
    ) {
      targetElementProps.targetString = sourceElement.asAny.sourceString;
      targetElementProps.targetDouble = sourceElement.asAny.sourceDouble;
      targetElementProps.targetBinary = sourceElement.asAny.sourceBinary;
      targetElementProps.targetNavigation = {
        id: this.context.findTargetElementId(
          sourceElement.asAny.sourceNavigation.id
        ),
        relClassName:
          "ExtensiveTestScenarioTarget:TargetPhysicalElementUsesTargetDefinition",
      };
    } else if (
      "ExtensiveTestScenario:SourceInformationRecord" ===
      sourceElement.classFullName
    ) {
      targetElementProps.targetString = sourceElement.asAny.sourceString;
    }
    return targetElementProps;
  }

  /** Override transformElementAspect to remap Source*Aspect --> Target*Aspect */
  public override onTransformElementAspect(
    sourceElementAspect: ElementAspect
  ): ElementAspectProps {
    const targetElementAspectProps: any = super.onTransformElementAspect(
      sourceElementAspect
    );
    if (
      "ExtensiveTestScenario:SourceUniqueAspect" ===
      sourceElementAspect.classFullName
    ) {
      targetElementAspectProps.classFullName =
        "ExtensiveTestScenarioTarget:TargetUniqueAspect";
      targetElementAspectProps.targetDouble =
        targetElementAspectProps.sourceDouble;
      targetElementAspectProps.sourceDouble = undefined;
      targetElementAspectProps.targetString =
        targetElementAspectProps.sourceString;
      targetElementAspectProps.sourceString = undefined;
      targetElementAspectProps.targetLong = targetElementAspectProps.sourceLong; // Id64 value was already remapped by super.transformElementAspect()
      targetElementAspectProps.sourceLong = undefined;
      targetElementAspectProps.targetGuid = targetElementAspectProps.sourceGuid;
      targetElementAspectProps.sourceGuid = undefined;
    } else if (
      "ExtensiveTestScenario:SourceMultiAspect" ===
      sourceElementAspect.classFullName
    ) {
      targetElementAspectProps.classFullName =
        "ExtensiveTestScenarioTarget:TargetMultiAspect";
      targetElementAspectProps.targetDouble =
        targetElementAspectProps.sourceDouble;
      targetElementAspectProps.sourceDouble = undefined;
      targetElementAspectProps.targetString =
        targetElementAspectProps.sourceString;
      targetElementAspectProps.sourceString = undefined;
      targetElementAspectProps.targetLong = targetElementAspectProps.sourceLong; // Id64 value was already remapped by super.transformElementAspect()
      targetElementAspectProps.sourceLong = undefined;
      targetElementAspectProps.targetGuid = targetElementAspectProps.sourceGuid;
      targetElementAspectProps.sourceGuid = undefined;
    }
    return targetElementAspectProps;
  }

  /** Override transformRelationship to remap SourceRelWithProps --> TargetRelWithProps */
  public override onTransformRelationship(
    sourceRelationship: Relationship
  ): RelationshipProps {
    const targetRelationshipProps: any = super.onTransformRelationship(
      sourceRelationship
    );
    if (
      "ExtensiveTestScenario:SourceRelWithProps" ===
      sourceRelationship.classFullName
    ) {
      targetRelationshipProps.classFullName =
        "ExtensiveTestScenarioTarget:TargetRelWithProps";
      targetRelationshipProps.targetString =
        targetRelationshipProps.sourceString;
      targetRelationshipProps.sourceString = undefined;
      targetRelationshipProps.targetDouble =
        targetRelationshipProps.sourceDouble;
      targetRelationshipProps.sourceDouble = undefined;
      targetRelationshipProps.targetLong = targetRelationshipProps.sourceLong; // Id64 value was already remapped by super.transformRelationship()
      targetRelationshipProps.sourceLong = undefined;
      targetRelationshipProps.targetGuid = targetRelationshipProps.sourceGuid;
      targetRelationshipProps.sourceGuid = undefined;
    }
    return targetRelationshipProps;
  }
}

/** Specialization of IModelTransformer for testing */
export class AspectTrackingTransformer extends IModelTransformer {
  public exportedAspectIdsByElement = new Map<
    Id64String,
    ElementMultiAspect[]
  >();

  public override onExportElementMultiAspects(
    sourceAspects: ElementMultiAspect[]
  ): void {
    const elementId = sourceAspects[0].element.id;
    assert(
      !this.exportedAspectIdsByElement.has(elementId),
      "tried to export element multi aspects for an element more than once"
    );
    this.exportedAspectIdsByElement.set(elementId, sourceAspects);
    return super.onExportElementMultiAspects(sourceAspects);
  }
}

/** a transformer which will throw an error if a given array of element ids are exported out of that list's order, or not at all*/
export class AssertOrderTransformer extends IModelTransformer {
  public constructor(
    private _exportOrderQueue: Id64String[],
    ...superArgs: ConstructorParameters<typeof IModelTransformer>
  ) {
    super(...superArgs);
  }

  public get errPrologue() {
    return "The export order given to AssertOrderTransformer was not followed";
  }
  public get errEpilogue() {
    return `The elements [${this._exportOrderQueue}] remain`;
  }

  public override onExportElement(elem: Element) {
    if (elem.id === this._exportOrderQueue[0]) this._exportOrderQueue.shift(); // pop the front
    // we just popped the queue if it was expected, so it shouldn't be there the order was correct (and there are no duplicates)
    const currentExportWasNotInExpectedOrder = this._exportOrderQueue.includes(
      elem.id
    );
    if (currentExportWasNotInExpectedOrder)
      throw Error(
        `${this.errPrologue}. '${elem.id}' came before the expected '${this._exportOrderQueue[0]}'. ${this.errEpilogue}`
      );
    return super.onExportElement(elem);
  }

  public override async process() {
    await super.process();
    if (this._exportOrderQueue.length > 0)
      throw Error(`${this.errPrologue}. ${this.errEpilogue}`);
  }
}

/** Specialization of IModelImporter that counts the number of times each callback is called. */
export class CountingIModelImporter extends IModelImporter {
  public numModelsInserted: number = 0;
  public numModelsUpdated: number = 0;
  public numElementsInserted: number = 0;
  public numElementsUpdated: number = 0;
  /**
   * This property does not include implicit deletions that occur when deleting trees.
   * Consider two PhysicalObjects A and B. PhysicalObject A has a code whose scope is PhysicalObject B. When PhysicalObject B is deleted,
   * PhysicalObject A gets deleted as a part of a cascading delete. The cascading delete is not recorded by onDeleteElement in this class.
   */
  public numElementsExplicitlyDeleted: number = 0;
  public numElementAspectsInserted: number = 0;
  public numElementAspectsUpdated: number = 0;
  public numRelationshipsInserted: number = 0;
  public numRelationshipsUpdated: number = 0;
  public numRelationshipsDeleted: number = 0;
  public constructor(targetDb: IModelDb, options?: IModelImportOptions) {
    super(targetDb, options);
  }
  protected override onInsertModel(modelProps: ModelProps): Id64String {
    this.numModelsInserted++;
    return super.onInsertModel(modelProps);
  }
  protected override onUpdateModel(modelProps: ModelProps): void {
    this.numModelsUpdated++;
    super.onUpdateModel(modelProps);
  }
  protected override onInsertElement(elementProps: ElementProps): Id64String {
    this.numElementsInserted++;
    return super.onInsertElement(elementProps);
  }
  protected override onUpdateElement(elementProps: ElementProps): void {
    this.numElementsUpdated++;
    super.onUpdateElement(elementProps);
  }
  protected override onDeleteElement(elementId: Id64String): void {
    this.numElementsExplicitlyDeleted++;
    super.onDeleteElement(elementId);
  }
  protected override onInsertElementAspect(
    aspectProps: ElementAspectProps
  ): Id64String {
    this.numElementAspectsInserted++;
    return super.onInsertElementAspect(aspectProps);
  }
  protected override onUpdateElementAspect(
    aspectProps: ElementAspectProps
  ): void {
    this.numElementAspectsUpdated++;
    super.onUpdateElementAspect(aspectProps);
  }
  protected override onInsertRelationship(
    relationshipProps: RelationshipProps
  ): Id64String {
    this.numRelationshipsInserted++;
    return super.onInsertRelationship(relationshipProps);
  }
  protected override onUpdateRelationship(
    relationshipProps: RelationshipProps
  ): void {
    this.numRelationshipsUpdated++;
    super.onUpdateRelationship(relationshipProps);
  }
  protected override onDeleteRelationship(
    relationshipProps: RelationshipPropsForDelete
  ): void {
    this.numRelationshipsDeleted++;
    super.onDeleteRelationship(relationshipProps);
  }
}

/** Specialization of IModelImporter that creates an InformationRecordElement for each PhysicalElement that it imports. */
export class RecordingIModelImporter extends CountingIModelImporter {
  public constructor(targetDb: IModelDb, options?: IModelImportOptions) {
    super(targetDb, options);
  }
  protected override onInsertModel(modelProps: ModelProps): Id64String {
    const modelId: Id64String = super.onInsertModel(modelProps);
    const model: Model = this.targetDb.models.getModel(modelId);
    if (model instanceof PhysicalModel) {
      const modeledElement: Element = this.targetDb.elements.getElement(
        model.modeledElement.id
      );
      if (modeledElement instanceof PhysicalPartition) {
        const parentSubjectId: Id64String = modeledElement.parent!.id; // InformationPartitionElements are always parented to Subjects
        const recordPartitionId: Id64String = InformationRecordModel.insert(
          this.targetDb,
          parentSubjectId,
          `Records for ${model.name}`
        );
        this.targetDb.relationships.insertInstance({
          classFullName:
            "ExtensiveTestScenarioTarget:PhysicalPartitionIsTrackedByRecords",
          sourceId: modeledElement.id,
          targetId: recordPartitionId,
        });
      }
    }
    return modelId;
  }
  protected override onInsertElement(elementProps: ElementProps): Id64String {
    const elementId: Id64String = super.onInsertElement(elementProps);
    const element: Element = this.targetDb.elements.getElement(elementId);
    if (element instanceof PhysicalElement) {
      const recordPartitionId: Id64String = this.getRecordPartitionId(
        element.model
      );
      if (Id64.isValidId64(recordPartitionId)) {
        this.insertAuditRecord("Insert", recordPartitionId, element);
      }
    }
    return elementId;
  }
  protected override onUpdateElement(elementProps: ElementProps): void {
    super.onUpdateElement(elementProps);
    const element: Element = this.targetDb.elements.getElement(
      elementProps.id!
    );
    if (element instanceof PhysicalElement) {
      const recordPartitionId: Id64String = this.getRecordPartitionId(
        element.model
      );
      if (Id64.isValidId64(recordPartitionId)) {
        this.insertAuditRecord("Update", recordPartitionId, element);
      }
    }
  }
  protected override onDeleteElement(elementId: Id64String): void {
    const element: Element = this.targetDb.elements.getElement(elementId);
    if (element instanceof PhysicalElement) {
      const recordPartitionId: Id64String = this.getRecordPartitionId(
        element.model
      );
      if (Id64.isValidId64(recordPartitionId)) {
        this.insertAuditRecord("Delete", recordPartitionId, element);
      }
    }
    super.onDeleteElement(elementId); // delete element after AuditRecord is inserted
  }
  private getRecordPartitionId(physicalPartitionId: Id64String): Id64String {
    const sql =
      "SELECT TargetECInstanceId FROM ExtensiveTestScenarioTarget:PhysicalPartitionIsTrackedByRecords WHERE SourceECInstanceId=:physicalPartitionId";
    return this.targetDb.withPreparedStatement(
      sql,
      (statement: ECSqlStatement): Id64String => {
        statement.bindId("physicalPartitionId", physicalPartitionId);
        return DbResult.BE_SQLITE_ROW === statement.step()
          ? statement.getValue(0).getId()
          : Id64.invalid;
      }
    );
  }
  private insertAuditRecord(
    operation: string,
    recordPartitionId: Id64String,
    physicalElement: PhysicalElement
  ): Id64String {
    const auditRecord: any = {
      classFullName: "ExtensiveTestScenarioTarget:AuditRecord",
      model: recordPartitionId,
      code: Code.createEmpty(),
      userLabel: `${operation} of ${physicalElement.getDisplayLabel()} at ${new Date()}`,
      operation,
      physicalElement: { id: physicalElement.id },
    };
    return this.targetDb.elements.insertElement(auditRecord);
  }
}

/** In addition to recording transformation processes with information record elements, also collects
 * test-specific data for tests to analyze.
 */
export class AspectTrackingImporter extends IModelImporter {
  public importedAspectIdsByElement = new Map<Id64String, Id64String[]>();
  public override importElementMultiAspects(
    ...args: Parameters<IModelImporter["importElementMultiAspects"]>
  ) {
    const resultTargetIds = super.importElementMultiAspects(...args);
    const [aspectsProps] = args;
    const elementId = aspectsProps[0].element.id;
    assert(
      !this.importedAspectIdsByElement.has(elementId),
      "should only export multiaspects for an element once"
    );
    this.importedAspectIdsByElement.set(elementId, resultTargetIds);
    return resultTargetIds;
  }
}

/** Specialization of IModelExport that exports to an output text file. */
export class IModelToTextFileExporter extends IModelExportHandler {
  public outputFileName: string;
  public exporter: IModelExporter;
  private _shouldIndent: boolean = true;
  private _firstFont: boolean = true;
  private _firstRelationship: boolean = true;
  public constructor(sourceDb: IModelDb, outputFileName: string) {
    super();
    this.outputFileName = outputFileName;
    this.exporter = new IModelExporter(sourceDb);
    this.exporter.registerHandler(this);
    this.exporter.wantGeometry = false;
  }
  public async export(): Promise<void> {
    this._shouldIndent = true;
    await this.exporter.exportSchemas();
    this.writeSeparator();
    await this.exporter.exportAll();
  }
  public async exportChanges(
    ...args: Parameters<IModelExporter["exportChanges"]>
  ): Promise<void> {
    this._shouldIndent = false;
    // eslint-disable-next-line deprecation/deprecation
    return this.exporter.exportChanges(...args);
  }
  private writeLine(line: string, indentLevel: number = 0): void {
    if (this._shouldIndent) {
      for (let i = 0; i < indentLevel; i++) {
        IModelJsFs.appendFileSync(this.outputFileName, "  ");
      }
    }
    IModelJsFs.appendFileSync(this.outputFileName, line);
    IModelJsFs.appendFileSync(this.outputFileName, "\n");
  }
  private writeSeparator(): void {
    this.writeLine("--------------------------------");
  }
  private formatOperationName(isUpdate: boolean | undefined): string {
    if (undefined === isUpdate) return "";

    return isUpdate ? ", UPDATE" : ", INSERT";
  }
  private getIndentLevelForElement(element: Element): number {
    if (!this._shouldIndent) {
      return 0;
    }
    if (undefined !== element.parent && Id64.isValidId64(element.parent.id)) {
      const parentElement: Element = this.exporter.sourceDb.elements.getElement(
        element.parent.id
      );
      return 1 + this.getIndentLevelForElement(parentElement);
    }
    return 1;
  }
  private getIndentLevelForElementAspect(aspect: ElementAspect): number {
    if (!this._shouldIndent) {
      return 0;
    }
    const element: Element = this.exporter.sourceDb.elements.getElement(
      aspect.element.id
    );
    return 1 + this.getIndentLevelForElement(element);
  }
  public override async onExportSchema(schema: Schema) {
    this.writeLine(`[Schema] ${schema.name}`);
    return super.onExportSchema(schema);
  }
  public override onExportCodeSpec(
    codeSpec: CodeSpec,
    isUpdate: boolean | undefined
  ): void {
    this.writeLine(
      `[CodeSpec] ${codeSpec.id}, ${codeSpec.name}${this.formatOperationName(
        isUpdate
      )}`
    );
    super.onExportCodeSpec(codeSpec, isUpdate);
  }
  public override onExportFont(
    font: FontProps,
    isUpdate: boolean | undefined
  ): void {
    if (this._firstFont) {
      this.writeSeparator();
      this._firstFont = false;
    }
    this.writeLine(`[Font] ${font.id}, ${font.name}`);
    super.onExportFont(font, isUpdate);
  }
  public override onExportModel(
    model: Model,
    isUpdate: boolean | undefined
  ): void {
    this.writeSeparator();
    this.writeLine(
      `[Model] ${model.classFullName}, ${model.id}, ${
        model.name
      }${this.formatOperationName(isUpdate)}`
    );
    super.onExportModel(model, isUpdate);
  }
  public override onExportElement(
    element: Element,
    isUpdate: boolean | undefined
  ): void {
    const indentLevel: number = this.getIndentLevelForElement(element);
    this.writeLine(
      `[Element] ${element.classFullName}, ${
        element.id
      }, ${element.getDisplayLabel()}${this.formatOperationName(isUpdate)}`,
      indentLevel
    );
    super.onExportElement(element, isUpdate);
  }
  public override onDeleteElement(elementId: Id64String): void {
    this.writeLine(`[Element] ${elementId}, DELETE`);
    super.onDeleteElement(elementId);
  }
  public override onExportElementUniqueAspect(
    aspect: ElementUniqueAspect,
    isUpdate: boolean | undefined
  ): void {
    const indentLevel: number = this.getIndentLevelForElementAspect(aspect);
    this.writeLine(
      `[Aspect] ${aspect.classFullName}, ${aspect.id}${this.formatOperationName(
        isUpdate
      )}`,
      indentLevel
    );
    super.onExportElementUniqueAspect(aspect, isUpdate);
  }
  public override onExportElementMultiAspects(
    aspects: ElementMultiAspect[]
  ): void {
    const indentLevel: number = this.getIndentLevelForElementAspect(aspects[0]);
    for (const aspect of aspects) {
      this.writeLine(
        `[Aspect] ${aspect.classFullName}, ${aspect.id}`,
        indentLevel
      );
    }
    super.onExportElementMultiAspects(aspects);
  }
  public override onExportRelationship(
    relationship: Relationship,
    isUpdate: boolean | undefined
  ): void {
    if (this._firstRelationship) {
      this.writeSeparator();
      this._firstRelationship = false;
    }
    this.writeLine(
      `[Relationship] ${relationship.classFullName}, ${
        relationship.id
      }${this.formatOperationName(isUpdate)}`
    );
    super.onExportRelationship(relationship, isUpdate);
  }
  public override onDeleteRelationship(relInstanceId: Id64String): void {
    this.writeLine(`[Relationship] ${relInstanceId}, DELETE`);
    super.onDeleteRelationship(relInstanceId);
  }
}

/** Specialization of IModelExport that counts occurrences of classes. */
export class ClassCounter extends IModelExportHandler {
  public outputFileName: string;
  public exporter: IModelExporter;
  private _modelClassCounts: Map<string, number> = new Map<string, number>();
  private _elementClassCounts: Map<string, number> = new Map<string, number>();
  private _aspectClassCounts: Map<string, number> = new Map<string, number>();
  private _relationshipClassCounts: Map<string, number> = new Map<
    string,
    number
  >();
  public constructor(sourceDb: IModelDb, outputFileName: string) {
    super();
    this.outputFileName = outputFileName;
    this.exporter = new IModelExporter(sourceDb);
    this.exporter.registerHandler(this);
    this.exporter.wantGeometry = false;
  }
  public async count(): Promise<void> {
    await this.exporter.exportAll();
    this.outputAllClassCounts();
  }
  private incrementClassCount(
    map: Map<string, number>,
    classFullName: string
  ): void {
    const count: number | undefined = map.get(classFullName);
    if (undefined === count) {
      map.set(classFullName, 1);
    } else {
      map.set(classFullName, 1 + count);
    }
  }
  private sortClassCounts(map: Map<string, number>): any[] {
    return Array.from(map).sort(
      (a: [string, number], b: [string, number]): number => {
        if (a[1] === b[1]) {
          return a[0] > b[0] ? 1 : -1;
        } else {
          return a[1] > b[1] ? -1 : 1;
        }
      }
    );
  }
  private outputAllClassCounts(): void {
    this.outputClassCounts(
      "Model",
      this.sortClassCounts(this._modelClassCounts)
    );
    this.outputClassCounts(
      "Element",
      this.sortClassCounts(this._elementClassCounts)
    );
    this.outputClassCounts(
      "ElementAspect",
      this.sortClassCounts(this._aspectClassCounts)
    );
    this.outputClassCounts(
      "Relationship",
      this.sortClassCounts(this._relationshipClassCounts)
    );
  }
  private outputClassCounts(
    title: string,
    classCounts: Array<[string, number]>
  ): void {
    IModelJsFs.appendFileSync(
      this.outputFileName,
      `=== ${title} Class Counts ===\n`
    );
    classCounts.forEach((value: [string, number]) => {
      IModelJsFs.appendFileSync(
        this.outputFileName,
        `${value[1]}, ${value[0]}\n`
      );
    });
    IModelJsFs.appendFileSync(this.outputFileName, "\n");
  }
  public override onExportModel(
    model: Model,
    isUpdate: boolean | undefined
  ): void {
    this.incrementClassCount(this._modelClassCounts, model.classFullName);
    super.onExportModel(model, isUpdate);
  }
  public override onExportElement(
    element: Element,
    isUpdate: boolean | undefined
  ): void {
    this.incrementClassCount(this._elementClassCounts, element.classFullName);
    super.onExportElement(element, isUpdate);
  }
  public override onExportElementUniqueAspect(
    aspect: ElementUniqueAspect,
    isUpdate: boolean | undefined
  ): void {
    this.incrementClassCount(this._aspectClassCounts, aspect.classFullName);
    super.onExportElementUniqueAspect(aspect, isUpdate);
  }
  public override onExportElementMultiAspects(
    aspects: ElementMultiAspect[]
  ): void {
    for (const aspect of aspects) {
      this.incrementClassCount(this._aspectClassCounts, aspect.classFullName);
    }
    super.onExportElementMultiAspects(aspects);
  }
  public override onExportRelationship(
    relationship: Relationship,
    isUpdate: boolean | undefined
  ): void {
    this.incrementClassCount(
      this._relationshipClassCounts,
      relationship.classFullName
    );
    super.onExportRelationship(relationship, isUpdate);
  }
}

/** In some cases during tests, you want to modify an existing immutable database, so you need to copy it which will change the id.
 * Forcing the same id will prevent the transformer from detecting invalid provenance/provenance conflicts
 */
export function copyDbPreserveId(sourceDb: IModelDb, pathForCopy: string) {
  const copy = SnapshotDb.createFrom(sourceDb, pathForCopy);
  copy["_iModelId"] = sourceDb.iModelId;
  return copy;
}

/**
 * Runs a function under the cpu profiler, by default creates cpu profiles in the working directory of
 * the test runner process.
 * You can override the default across all calls with the environment variable ITWIN_TESTS_CPUPROF_DIR,
 * or per functoin just pass a specific `profileDir`
 */
export async function runWithCpuProfiler<F extends () => any>(
  f: F,
  {
    profileDir = process.env.ITWIN_TESTS_CPUPROF_DIR ?? process.cwd(),
    /** append an ISO timestamp to the name you provided */
    timestamp = true,
    profileName = "profile",
    /** an extension to append to the profileName, including the ".". Defaults to ".js.cpuprofile" */
    profileExtension = ".js.cpuprofile",
    /** profile sampling interval in microseconds, you may want to adjust this to increase the resolution of your test
     * default to half a millesecond
     */
    sampleIntervalMicroSec = 500, // half a millisecond
  } = {}
): Promise<ReturnType<F>> {
  const maybeNameTimePortion = timestamp ? `_${new Date().toISOString()}` : "";
  const profilePath = path.join(
    profileDir,
    `${profileName}${maybeNameTimePortion}${profileExtension}`
  );
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // implementation influenced by https://github.com/wallet77/v8-inspector-api/blob/master/src/utils.js
  const invokeFunc = async (
    thisSession: inspector.Session,
    funcName: string,
    args: any = {}
  ) => {
    return new Promise<void>((resolve, reject) => {
      thisSession.post(funcName, args, (err) =>
        err ? reject(err) : resolve()
      );
    });
  };
  const stopProfiler = async (
    thisSession: inspector.Session,
    funcName: "Profiler.stop",
    writePath: string
  ) => {
    return new Promise<void>((resolve, reject) => {
      thisSession.post(funcName, async (err, res) => {
        if (err) return reject(err);
        await fs.promises.writeFile(writePath, JSON.stringify(res.profile));
        resolve();
      });
    });
  };
  const session = new inspector.Session();
  session.connect();
  await invokeFunc(session, "Profiler.enable");
  await invokeFunc(session, "Profiler.setSamplingInterval", {
    interval: sampleIntervalMicroSec,
  });
  await invokeFunc(session, "Profiler.start");
  const result = await f();
  await stopProfiler(session, "Profiler.stop", profilePath);
  await invokeFunc(session, "Profiler.disable");
  session.disconnect();
  return result;
}

export function getProfileVersion(db: IModelDb): ProfileVersion {
  const rows = db.withPreparedSqliteStatement(
    "SELECT Name,StrData FROM be_Prop WHERE Namespace='ec_Db' AND Name='SchemaVersion'",
    (s) => [...s]
  );
  const profile = JSON.parse(rows[0].strData);
  assert(profile.major !== undefined);
  assert(profile.minor !== undefined);
  assert(profile.sub1 !== undefined);
  assert(profile.sub2 !== undefined);
  return profile;
}

export interface ProfileVersion {
  major: number;
  minor: number;
  sub1: number;
  sub2: number;
}

/**
 * Compare two profile versions, returning
 * a positive integer if the first is greater than the second,
 * 0 if they are equal,
 * or a negative integer if the first is less than the second
 */
export function cmpProfileVersion(
  a: ProfileVersion,
  b: ProfileVersion
): number {
  for (const subKey of ["major", "minor", "sub1", "sub2"] as const) {
    if (a[subKey] > b[subKey]) return 1;
    else if (a[subKey] < b[subKey]) return -1;
  }
  return 0;
}
