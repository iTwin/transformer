/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module iModels
 */
import * as assert from "assert";
import { DbResult, Id64, Id64String, Logger } from "@itwin/core-bentley";
import {
  Code, CodeScopeSpec, CodeSpec, ElementAspectProps, ElementProps, EntityProps, GeometricElementProps, IModel, IModelError,
  PrimitiveTypeCode, PropertyMetaData, RelatedElement, RelatedElementProps, SpatialViewDefinitionProps, ViewDefinition2dProps, ViewDefinitionProps,
} from "@itwin/core-common";
import {
  ClassRegistry,
  Element, ElementAspect, Entity, GeometricElement3d, GeometryPart, IModelDb, IModelElementCloneContext, IModelJsNative, SpatialViewDefinition, SQLiteDb, ViewDefinition, ViewDefinition2d,
} from "@itwin/core-backend";
import { ECReferenceTypesCache } from "./ECReferenceTypesCache";
import { EntityUnifier } from "./EntityUnifier";
import { TransformerLoggerCategory } from "./TransformerLoggerCategory";
import { ConcreteEntityTypes, EntityReference, EntityReferences } from "./EntityReference";

const loggerCategory: string = TransformerLoggerCategory.IModelCloneContext;

/** The context for transforming a *source* Element to a *target* Element and remapping internal identifiers to the target iModel.
 * @beta
 */
export class IModelCloneContext implements Omit<IModelElementCloneContext, "remapElement" | "findTargetElementId" | "cloneElement" | "findTargetCodeSpecId"> {
  private _refTypesCache = new ECReferenceTypesCache();
  private _nativeContext: IModelElementCloneContext;

  public sourceDb: IModelDb;
  public targetDb: IModelDb;

  public constructor(...[sourceDb, targetDb]: ConstructorParameters<typeof IModelElementCloneContext>) {
    this._nativeContext = new IModelElementCloneContext(sourceDb, targetDb);
    this.sourceDb = this._nativeContext.sourceDb;
    this.targetDb = this._nativeContext.targetDb;
  }

  /** perform necessary initialization to use a clone context, namely caching the reference types in the source's schemas */
  public async initialize() {
    await this._refTypesCache.initAllSchemasInIModel(this.sourceDb);
  }

  public importFont(_id: number) {
    // FIXME: implement!
  }

  /**
   * Returns `true` if this context is for transforming between 2 iModels and `false` if it for transforming within the same iModel.
   * @deprecated, use [[targetIsSource]]
   */
  public get isBetweenIModels(): boolean { return !this.targetIsSource; }

  /** Returns `true` if this context is for transforming between 2 iModels and `false` if it for transforming within the same iModel. */
  public get targetIsSource(): boolean { return this.sourceDb === this.targetDb; }

  private _aspectRemapTable = new Map<Id64String, Id64String>([[Id64.invalid, Id64.invalid]]);
  private _elementRemapTable = new Map<Id64String, Id64String>([[Id64.invalid, Id64.invalid], ["0x1", "0x1"]]);
  private _codeSpecRemapTable = new Map<Id64String, Id64String>([[Id64.invalid, Id64.invalid]]);

  private _elementClassRemapTable = new Map<typeof Entity, typeof Entity>();

  /** Add a rule that remaps the specified source [CodeSpec]($common) to the specified target [CodeSpec]($common).
   * @param sourceCodeSpecName The name of the CodeSpec from the source iModel.
   * @param targetCodeSpecName The name of the CodeSpec from the target iModel.
   * @throws [[IModelError]] if either CodeSpec could not be found.
   */
  public remapCodeSpec(sourceCodeSpecName: string, targetCodeSpecName: string): void {
    const sourceCodeSpec = this.sourceDb.codeSpecs.getByName(sourceCodeSpecName);
    const targetCodeSpec = this.targetDb.codeSpecs.getByName(targetCodeSpecName);
    this._codeSpecRemapTable.set(sourceCodeSpec.id, targetCodeSpec.id);
  }

  /** Add a rule that remaps the specified source class to the specified target class. */
  public remapElementClass(sourceClassFullName: string, targetClassFullName: string): void {
    try {
      const sourceClass = this.sourceDb.getJsClass(sourceClassFullName);
      const targetClass = this.targetDb.getJsClass(targetClassFullName);
      this._elementClassRemapTable.set(sourceClass, targetClass);
    } catch (err: any) {
      // FIXME: core can't generate class for relationship entities in this case apparently
      if (!/has no superclass$/.test(err.message))
        throw err;
    }
  }

  /** Add a rule that remaps the specified source Element to the specified target Element. */
  public remapElement(sourceId: Id64String, targetId: Id64String): void {
    this._elementRemapTable.set(sourceId, targetId);
  }

  /** Remove a rule that remaps the specified source Element. */
  public removeElement(sourceId: Id64String): void {
    this._elementRemapTable.delete(sourceId);
  }

  /** Look up a target CodeSpecId from the source CodeSpecId.
   * @returns the target CodeSpecId or [Id64.invalid]($bentley) if a mapping not found.
   */
  public findTargetCodeSpecId(sourceId: Id64String): Id64String {
    return this._codeSpecRemapTable.get(sourceId) ?? Id64.invalid;
  }

  /** Look up a target ElementId from the source ElementId.
   * @returns the target ElementId or [Id64.invalid]($bentley) if a mapping not found.
   */
  public findTargetElementId(sourceElementId: Id64String): Id64String {
    return this._elementRemapTable.get(sourceElementId) ?? Id64.invalid;
  }

  /** Add a rule that remaps the specified source ElementAspect to the specified target ElementAspect. */
  public remapElementAspect(aspectSourceId: Id64String, aspectTargetId: Id64String): void {
    this._aspectRemapTable.set(aspectSourceId, aspectTargetId);
  }

  /** Remove a rule that remaps the specified source ElementAspect */
  public removeElementAspect(aspectSourceId: Id64String): void {
    this._aspectRemapTable.delete(aspectSourceId);
  }

  /** Look up a target AspectId from the source AspectId.
   * @returns the target AspectId or [Id64.invalid]($bentley) if a mapping not found.
   */
  public findTargetAspectId(sourceAspectId: Id64String): Id64String {
    return this._aspectRemapTable.get(sourceAspectId) ?? Id64.invalid;
  }

  /** Look up a target [[EntityReference]] from a source [[EntityReference]]
   * @returns the target CodeSpecId or a [EntityReference]($bentley) containing [Id64.invalid]($bentley) if a mapping is not found.
   */
  public findTargetEntityId(sourceEntityId: EntityReference): EntityReference {
    const [type, rawId] = EntityReferences.split(sourceEntityId);
    if (Id64.isValid(rawId)) {
      switch (type) {
        case ConcreteEntityTypes.Model: {
          const targetId = `m${this.findTargetElementId(rawId)}` as const;
          return targetId;
          // Check if the model exists, `findTargetElementId` may have worked because the element exists when the model doesn't.
          // That can occur in the transformer since a submodeled element is imported before its submodel.
          /*
          // FIXME: target checks don't work, just rely on the target element being inserted?
          if (EntityUnifier.exists(this.targetDb, { entityReference: targetId }))
            return targetId;
          */
        }
        case ConcreteEntityTypes.Element:
          return `e${this.findTargetElementId(rawId)}`;
        case ConcreteEntityTypes.ElementAspect:
          return `a${this.findTargetAspectId(rawId)}`;
        case ConcreteEntityTypes.Relationship: {
          const makeGetConcreteEntityTypeSql = (property: string) => `
            CASE
              WHEN [${property}] IS (BisCore.ElementUniqueAspect) OR [${property}] IS (BisCore.ElementMultiAspect)
                THEN 'a'
              WHEN [${property}] IS (BisCore.Element)
                THEN 'e'
              WHEN [${property}] IS (BisCore.Model)
                THEN 'm'
              WHEN [${property}] IS (BisCore.CodeSpec)
                THEN 'c'
              WHEN [${property}] IS (BisCore.ElementRefersToElements) -- TODO: ElementDrivesElement still not handled by the transformer
                THEN 'r'
              ELSE 'error'
            END
          `;
          const relInSource = this.sourceDb.withPreparedStatement(
            `
            SELECT
              SourceECInstanceId,
              TargetECInstanceId,
              (${makeGetConcreteEntityTypeSql("SourceECClassId")}) AS SourceType,
              (${makeGetConcreteEntityTypeSql("TargetECClassId")}) AS TargetType
            FROM BisCore:ElementRefersToElements
            WHERE ECInstanceId=?
            `, (stmt) => {
              stmt.bindId(1, rawId);
              let status: DbResult;
              while ((status = stmt.step()) === DbResult.BE_SQLITE_ROW) {
                const sourceId = stmt.getValue(0).getId();
                const targetId = stmt.getValue(1).getId();
                const sourceType = stmt.getValue(2).getString() as ConcreteEntityTypes | "error";
                const targetType = stmt.getValue(3).getString() as ConcreteEntityTypes | "error";
                if (sourceType === "error" || targetType === "error")
                  throw Error("relationship end had unknown root class");
                return {
                  sourceId: `${sourceType}${sourceId}`,
                  targetId: `${targetType}${targetId}`,
                } as const;
              }
              if (status !== DbResult.BE_SQLITE_DONE)
                throw new IModelError(status, "unexpected query failure");
              return undefined;
            });
          if (relInSource === undefined)
            break;
          // just in case prevent recursion
          if (relInSource.sourceId === sourceEntityId || relInSource.targetId === sourceEntityId)
            throw Error("link table relationship end was resolved to itself. This should be impossible");
          const relInTarget = {
            sourceId: this.findTargetEntityId(relInSource.sourceId),
            targetId: this.findTargetEntityId(relInSource.targetId),
          };
          // return a null
          if (Id64.isInvalid(relInTarget.sourceId) || Id64.isInvalid(relInTarget.targetId))
            break;
          const relInTargetId = this.sourceDb.withPreparedStatement(
            `
            SELECT ECInstanceId
            FROM BisCore:ElementRefersToElements
            WHERE SourceECInstanceId=?
              AND TargetECInstanceId=?
            `, (stmt) => {
              stmt.bindId(1, EntityReferences.toId64(relInTarget.sourceId));
              stmt.bindId(2, EntityReferences.toId64(relInTarget.targetId));
              let status: DbResult;
              if ((status = stmt.step()) === DbResult.BE_SQLITE_ROW)
                return stmt.getValue(0).getId();
              if (status !== DbResult.BE_SQLITE_DONE)
                throw new IModelError(status, "unexpected query failure");
              return Id64.invalid;
            });
          return `r${relInTargetId}`;
        }
        case ConcreteEntityTypes.CodeSpec: {
          return `c${this.findTargetCodeSpecId(rawId)}`;
        }
      }
    }
    return `${type}${Id64.invalid}`;
  }

  /** Clone the specified source Element into ElementProps for the target iModel.
   * @internal
   */
  public cloneElementAspect(sourceElementAspect: ElementAspect): ElementAspectProps {
    return this._cloneEntity(sourceElementAspect);
  }

  private _cloneEntity<
    EntitySubType extends Entity = Entity,
    EntityPropsSubType extends EntityProps = EntityProps,
  >(
    sourceEntity: EntitySubType,
    /**
     * custom handlers for setting cloned values in the props using the source entity
     * e.g. to handle differently named props between Entities and their Prop type.
     * The keys of the record are the key of the property in the source entity (as
     * defined by that entity's metadata)
     */
    customNavPropHandlers: Record<string, {
      /** from an entity get an entity reference */
      getSource(this: void, source: EntitySubType): EntityReference;
      setTarget(this: void, target: EntityPropsSubType, e: EntityReference): void;
    }> = {},
  ): EntityPropsSubType {
    const targetEntityProps = sourceEntity.toJSON() as EntityPropsSubType;

    // toJSON performs a shallow clone, but we mutate deep fields of code, which may be referenced later
    // REPORTME: core should do a full JSON copy, other object fields are also not properly cloned
    if (sourceEntity instanceof Element) {
      (targetEntityProps as unknown as ElementProps).code = { ...sourceEntity.code };
    }

    if (this.targetIsSource)
      return targetEntityProps;

    // TODO: it's possible since we do this so much that it will be faster to use `new Function` to inline the remappin
    // code for each element class (profile first to see how long this takes)
    sourceEntity.forEachProperty((propertyName, propertyMetaData) => {
      if (propertyName in customNavPropHandlers) {
        const { getSource, setTarget } = customNavPropHandlers[propertyName];
        // we know for know specialHandledProps are only on elements, that may change
        setTarget(targetEntityProps, this.findTargetEntityId(getSource(sourceEntity)));
      } else if (propertyMetaData.isNavigation) {
        const sourceNavProp: RelatedElementProps | undefined = (sourceEntity as any)[propertyName];
        const sourceNavId = typeof sourceNavProp === "string" ? sourceNavProp : sourceNavProp?.id;
        if (sourceNavId) {
          const navPropRefType = this._refTypesCache.getNavPropRefType(
            sourceEntity.schemaName,
            sourceEntity.className,
            propertyName
          );
          assert(navPropRefType !== undefined, `nav prop ref type for '${propertyName}' was not in the cache, this is a bug.`);
          const targetEntityReference = this.findTargetEntityId(EntityReferences.fromEntityType(sourceNavId, navPropRefType));
          const targetEntityId = EntityReferences.toId64(targetEntityReference);
          // spread the property in case toJSON did not deep-clone
          (targetEntityProps as any)[propertyName] = typeof sourceNavProp === "string" ? targetEntityId : { ...(targetEntityProps as any)[propertyName], id: targetEntityId };
        }
      } else if ((PrimitiveTypeCode.Long === propertyMetaData.primitiveType) && ("Id" === propertyMetaData.extendedType)) {
        (targetEntityProps as any)[propertyName] = this.findTargetElementId((sourceEntity as any)[propertyName]);
      }
    });

    return targetEntityProps;
  }

  /** Clone the specified source Element into ElementProps for the target iModel.
   * @internal
   */
  public cloneElement(sourceElement: Element, cloneOptions?: IModelJsNative.CloneElementOptions): ElementProps {
    const specialHandledProps = {
      codeSpec: {
        getSource: (source: Element): EntityReference => `c${source.code.spec}`,
        setTarget: (target: ElementProps, e: EntityReference) => target.code.spec = EntityReferences.toId64(e),
      },
      codeScope: {
        getSource: (source: Element): EntityReference => `e${source.code.scope}`,
        setTarget: (target: ElementProps, e: EntityReference) => target.code.scope = EntityReferences.toId64(e),
      },
      modelSelector: {
        getSource: (source: SpatialViewDefinition): EntityReference => `e${source.modelSelectorId}`,
        setTarget: (target: SpatialViewDefinitionProps, e: EntityReference) => target.modelSelectorId = EntityReferences.toId64(e),
      },
      displayStyle: {
        getSource: (source: ViewDefinition): EntityReference => `e${source.displayStyleId}`,
        setTarget: (target: ViewDefinitionProps, e: EntityReference) => target.displayStyleId = EntityReferences.toId64(e),
      },
      categorySelector: {
        getSource: (source: ViewDefinition): EntityReference => `e${source.categorySelectorId}`,
        setTarget: (target: ViewDefinitionProps, e: EntityReference) => target.categorySelectorId = EntityReferences.toId64(e),
      },
      baseModel: {
        getSource: (source: ViewDefinition2d): EntityReference => `e${source.baseModelId}`,
        setTarget: (target: ViewDefinition2dProps, e: EntityReference) => target.baseModelId = EntityReferences.toId64(e),
      },
    };

    // Clone
    const targetElemProps = this._cloneEntity<Element, ElementProps>(sourceElement, specialHandledProps);

    targetElemProps.code = { ...targetElemProps.code, value: targetElemProps.code.value };
    delete (targetElemProps.code as any)._value;

    // attach geometry
    if (cloneOptions?.binaryGeometry) {
      // TODO: handle 2d
      if (sourceElement instanceof GeometricElement3d) {
        this.sourceDb.withPreparedSqliteStatement("SELECT GeometryStream FROM bis_GeometricElement3d WHERE ElementId=?", (stmt) => {
          stmt.bindId(1, sourceElement.id);
          assert(stmt.step() === DbResult.BE_SQLITE_ROW);
          const geomBinary = stmt.getValue(0).getBlob();
          assert(stmt.step() === DbResult.BE_SQLITE_DONE);
          (targetElemProps as any)["geomBinary"] = geomBinary;

        });
      }
      if (sourceElement instanceof GeometryPart) {
        this.sourceDb.withPreparedStatement("SELECT GeometryStream FROM bis.GeometryPart WHERE ECInstanceId=?", (stmt) => {
          stmt.bindId(1, sourceElement.id);
          assert(stmt.step() === DbResult.BE_SQLITE_ROW);
          const geomBinary = stmt.getValue(0).getBlob();
          assert(stmt.step() === DbResult.BE_SQLITE_DONE);
          (targetElemProps as any)["geomBinary"] = geomBinary;
        });
      }
    }

    if (!cloneOptions?.binaryGeometry)
      throw Error("not yet supported, will require the native context to be modified");

    // // FIXME: do we still need this?
    // Ensure that all NavigationProperties in targetElementProps have a defined value
    // so "clearing" changes will be part of the JSON used for update
    sourceElement.forEachProperty((propertyName: string, meta: PropertyMetaData) => {
      if ((meta.isNavigation) && (undefined === (sourceElement as any)[propertyName])) {
        (targetElemProps as any)[propertyName] = RelatedElement.none;
      }
    }, false); // exclude custom because C++ has already handled them (THIS IS NOW FALSE)

    if (this.targetIsSource) {
      // The native C++ cloneElement strips off federationGuid, want to put it back if transformation is into itself
      targetElemProps.federationGuid = sourceElement.federationGuid;
      if (CodeScopeSpec.Type.Repository === this.targetDb.codeSpecs.getById(targetElemProps.code.spec).scopeType) {
        targetElemProps.code.scope = IModelDb.rootSubjectId;
      }
    }

    // FIXME/NEXT: this doesn't work for category elements which have name restrictions,
    // the native code used to actually go import the corresponding codespec (idk about codescope atm),
    // need to either create a special name or add code.scope and code.spec to the required elements list

    // unlike other references, code cannot be null. If it is null, use an empty code instead
    if (targetElemProps.code.scope === Id64.invalid || targetElemProps.code.spec === Id64.invalid) {
      targetElemProps.code = Code.createEmpty();
      //targetElementProps.code.value = IModelCloneContext.unresolvedCode;
    }
    const jsClass = this.sourceDb.getJsClass<typeof Element>(sourceElement.classFullName);
    // eslint-disable-next-line @typescript-eslint/dot-notation
    jsClass["onCloned"](this._nativeContext, sourceElement.toJSON(), targetElemProps);
    return targetElemProps;
  }

  public static readonly unresolvedCodeValue = "@@TRANSFORMER_UNRESOLVED_CODE!~~";

  /** Import a single CodeSpec from the source iModel into the target iModel.
   * @internal
   */
  public importCodeSpec(sourceCodeSpecId: Id64String): void {
    if (this._codeSpecRemapTable.has(sourceCodeSpecId))
      return;
    if (this.targetIsSource)
      return;
    const sourceCodeSpec = this.sourceDb.codeSpecs.getById(sourceCodeSpecId);

    // TODO: would be more efficient if we let the underlying importer handle name collisions
    let targetCodeSpec: CodeSpec | undefined = undefined;
    try {
      targetCodeSpec = this.targetDb.codeSpecs.getByName(sourceCodeSpec.name);
    } catch { /* ignore */ }

    const targetId = targetCodeSpec
      ? targetCodeSpec.id
      // FIXME: awaiting because we know this is replaced with a promise return value when using a MultiProcess importer
      : this.targetDb.codeSpecs.insert(CodeSpec.create(undefined as any, sourceCodeSpec.name, sourceCodeSpec.scopeType, sourceCodeSpec.scopeReq));

    this._codeSpecRemapTable.set(sourceCodeSpecId, targetId);
  }


  private static aspectRemapTableName = "AspectIdRemaps";

  public saveStateToDb(db: SQLiteDb): void {
    this._nativeContext.saveStateToDb(db);
    if (DbResult.BE_SQLITE_DONE !== db.executeSQL(
      `CREATE TABLE ${IModelCloneContext.aspectRemapTableName} (Source INTEGER, Target INTEGER)`
    ))
      throw Error("Failed to create the aspect remap table in the state database");
    db.saveChanges();
    db.withPreparedSqliteStatement(
      `INSERT INTO ${IModelCloneContext.aspectRemapTableName} (Source, Target) VALUES (?, ?)`,
      (stmt) => {
        for (const [source, target] of this._aspectRemapTable) {
          stmt.reset();
          stmt.bindId(1, source);
          stmt.bindId(2, target);
          if (DbResult.BE_SQLITE_DONE !== stmt.step())
            throw Error("Failed to insert aspect remapping into the state database");
        }
      });
  }

  public loadStateFromDb(db: SQLiteDb): void {
    this._nativeContext.loadStateFromDb(db);
    // FIXME: test this
    db.withSqliteStatement(`SELECT Source, Target FROM ${IModelCloneContext.aspectRemapTableName}`, (stmt) => {
      let status = DbResult.BE_SQLITE_ERROR;
      while ((status = stmt.step()) === DbResult.BE_SQLITE_ROW) {
        const source = stmt.getValue(0).getId();
        const target = stmt.getValue(1).getId();
        this._aspectRemapTable.set(source, target);
      }
      assert(status === DbResult.BE_SQLITE_DONE);
    });
  }

  public get dump() { return this._nativeContext.dump.bind(this._nativeContext); }
  public get filterSubCategory() { return this._nativeContext.filterSubCategory.bind(this._nativeContext); }
  public get hasSubCategoryFilter() { return this._nativeContext.hasSubCategoryFilter; }
  public get isSubCategoryFiltered() { return this._nativeContext.isSubCategoryFiltered.bind(this._nativeContext); }
  public get dispose() { return this._nativeContext.dispose.bind(this._nativeContext); }
}

