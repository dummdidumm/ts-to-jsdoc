import path from "path";
import {
	ArrowFunction,
	ConstructorDeclaration,
	ExportAssignment,
	Node,
	ObjectLiteralExpression,
	Project,
	ScriptTarget,
	Type,
	TypeNode,
} from "ts-morph";

import type {
	ClassDeclaration,
	FunctionLikeDeclaration,
	InterfaceDeclaration,
	JSDoc,
	JSDocableNode,
	MethodDeclaration,
	ModifierableNode,
	PropertyAssignment,
	PropertyDeclaration,
	PropertySignature,
	SourceFile,
	TypeAliasDeclaration,
	TypedNode,
	VariableStatement,
} from "ts-morph";

declare module "ts-morph" {
	// eslint-disable-next-line no-shadow
	namespace Node {
		let isObjectProperty: (node: Node) => boolean;
	}
}
Node.isObjectProperty = (node): node is ObjectProperty =>
	Node.isPropertyDeclaration(node) ||
	Node.isPropertyAssignment(node) ||
	Node.isPropertySignature(node);

type ObjectProperty = JSDocableNode &
	TypedNode &
	(PropertyDeclaration | PropertyAssignment | PropertySignature);
type ClassMemberNode = JSDocableNode &
	ModifierableNode &
	ObjectProperty &
	MethodDeclaration;

/** Get children for object node */
function getChildProperties(node: Node): ObjectProperty[] {
	const properties = node?.getType()?.getProperties();
	const valueDeclarations = properties
		.map((child) => child.getValueDeclaration())
		// Hacky way to check if the child is actually a defined child in the interface
		// or if it's, e.g. a built-in method of the type (such as array.length)
		?.filter((child) => node.getFullText().includes(child?.getFullText()));
	return (valueDeclarations ?? []) as ObjectProperty[];
}

/** Get JSDoc for a node or create one if there isn't any */
function getJsDocOrCreate(node: JSDocableNode): JSDoc {
	node = // @ts-ignore
		Node.isArrowFunction(node) &&
		Node.isVariableStatement(node.getParent().getParent().getParent())
			? (node.getParent().getParent().getParent() as any)
			: node;
	return node.getJsDocs()[0] || node.addJsDoc({});
}

function resolve_type(node: Node, type: TypeNode | Type | undefined) {
	const text = type?.getText();
	if (!text) {
		return "";
	}

	// Add import(..) to types that are not in the same file
	// Assumption: All types are first letter uppercase
	return text.replace(
		/(\W|^)([A-Z][a-zA-Z_$\d]*)(?=\W|$)/g,
		(_, prefix, match) => {
			let is_default = false;
			let imported = node
				.getSourceFile()
				.getImportDeclarations()
				.find((i) => {
					let found = !!i.getNamedImports().find((n) => {
						return n.getName() === match;
					});
					if (!found) {
						found = i.getDefaultImport()?.getText() === match;
						if (found) {
							is_default = true;
						}
					}
					return found;
				});

			let import_str = "";
			if (imported) {
				let specifier = imported.getModuleSpecifierValue();
				if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
					specifier = specifier + ".js";
				}
				import_str = `import('${specifier}').`;
			}

			return `${prefix}${import_str}${is_default ? "default" : match}`;
		}
	);
}

/** Sanitize a string to use as a type in a doc comment so that it is compatible with JSDoc */
function sanitizeType(str: string): string | null {
	if (!str) return null;
	// Convert `typeof MyClass` syntax to `Class<MyClass>`
	const extractedClassFromTypeof = /{*typeof\s+([^(?:}|\s);]*)/gm.exec(
		str
	)?.[1];
	if (extractedClassFromTypeof) str = `Class<${extractedClassFromTypeof}>`;
	str = str.replace(/\/\*\*.+?\*\//gs, ""); // strip out jsdoc comments
	return str;
}

/**
 * Generate @param documentation from function parameters, storing it in functionNode
 */
function generateParameterDocumentation(
	functionNode: FunctionLikeDeclaration | ArrowFunction | ConstructorDeclaration
): void {
	const generics = functionNode.getTypeParameters();
	for (const generic of generics) {
		const name = generic.getName();
		const constraint = generic.getConstraint()?.getText();
		const defaultType = generic.getDefault()?.getText();
		const jsDoc = getJsDocOrCreate(functionNode);
		jsDoc.addTag({
			tagName: "template",
			text:
				(constraint ? `{${constraint}} ` : "") +
				(defaultType ? `[${name}=${defaultType}` : name),
		});
	}

	const params = functionNode.getParameters();
	for (const param of params) {
		const parameterType =
			sanitizeType(resolve_type(param, param.getTypeNode())) || "any";
		// Get param tag that matches the param
		const jsDoc = getJsDocOrCreate(functionNode);
		const paramTag = (jsDoc.getTags() || [])
			.filter((tag) => ["param", "parameter"].includes(tag.getTagName()))
			// @ts-ignore
			.find((tag) => tag.compilerNode.name?.getText() === param.getName());

		const paramNameRaw = param.compilerNode.name?.getText();
		// Skip parameter names if they are present in the type as an object literal
		// e.g. destructuring; { a }: { a: string }
		const paramName = paramNameRaw.match(/[{},]/)
			? ""
			: param.hasQuestionToken()
			? ` [${paramNameRaw}]`
			: ` ${paramNameRaw}`;
		if (paramTag) {
			// Replace tag with one that contains type info
			const comment = paramTag.getComment();
			const tagName = paramTag.getTagName();

			paramTag.replaceWithText(
				`@${tagName} {${parameterType}}${paramName}  ${comment}`
			);
		} else {
			jsDoc.addTag({
				tagName: "param",
				text: `{${parameterType}}${paramName}`,
			});
		}
	}
}

/**
 * Generate @returns documentation from function return type, storing it in functionNode
 */
function generateReturnTypeDocumentation(
	functionNode: FunctionLikeDeclaration
): void {
	if (!functionNode.getReturnTypeNode()) return; // Don't let ts-morph infer the type, let TS do it

	const functionReturnType = sanitizeType(
		resolve_type(functionNode as any, functionNode.getReturnType())
	);
	const jsDoc = getJsDocOrCreate(functionNode);
	const returnsTag = (jsDoc?.getTags() || []).find((tag) =>
		["returns", "return"].includes(tag.getTagName())
	);
	// Replace tag with one that contains type info if tag exists
	if (returnsTag) {
		const tagName = returnsTag.getTagName();
		const comment = returnsTag.getComment();
		// https://github.com/google/closure-compiler/wiki/Annotating-JavaScript-for-the-Closure-Compiler#return-type-description
		if (functionReturnType !== "void") {
			returnsTag.replaceWithText(
				`@${tagName} {${functionReturnType}}${comment ? ` ${comment}` : ""}`
			);
		}
	} else {
		// Otherwise, create a new one
		jsDoc.addTag({
			tagName: "returns",
			text: `{${functionReturnType}}`,
		});
	}
}

/**
 * Generate documentation for a function, storing it in functionNode
 */
function generateFunctionDocumentation(
	functionNode: FunctionLikeDeclaration
): void {
	generateParameterDocumentation(functionNode);
	generateReturnTypeDocumentation(functionNode);
	functionNode.getFunctions().forEach(generateFunctionDocumentation);
}

function generateVariableDocumentation(node: VariableStatement): void {
	for (const declaration of node.getDeclarations()) {
		if (declaration.getName() === "__tsToJsdoc_protectCommentsHeader") {
			continue;
		}

		const initializer = declaration.getInitializer();
		if (
			Node.isFunctionLikeDeclaration(initializer) ||
			Node.isArrowFunction(initializer)
		) {
			generateFunctionDocumentation(initializer);
		} else {
			const type = sanitizeType(
				resolve_type(declaration, declaration.getTypeNode())
			);
			if (type) {
				const jsDoc = getJsDocOrCreate(node);
				jsDoc.addTag({ tagName: "type", text: `{${type}}` });
			}

			if (Node.isObjectLiteralExpression(initializer)) {
				generateObjectLiteralExpressionDocumentation(initializer);
			}
		}
	}
}

function generateObjectLiteralExpressionDocumentation(
	node: ObjectLiteralExpression
) {
	for (const property of node.getProperties()) {
		if (Node.isPropertyAssignment(property)) {
			const initializer = property.getInitializer();
			if (Node.isObjectLiteralExpression(initializer)) {
				generateObjectLiteralExpressionDocumentation(initializer);
			} else if (
				Node.isFunctionLikeDeclaration(initializer) ||
				Node.isArrowFunction(initializer)
			) {
				generateFunctionDocumentation(initializer);
			}
		} else if (Node.isMethodDeclaration(property)) {
			generateFunctionDocumentation(property);
		}
	}
}

function generateExportDocumentation(node: ExportAssignment) {
	const expression = node.getExpression();
	if (Node.isObjectLiteralExpression(expression)) {
		generateObjectLiteralExpressionDocumentation(expression);
	}
}

/** Generate modifier documentation for class member */
function generateModifierDocumentation(classMemberNode: ClassMemberNode): void {
	const modifiers = classMemberNode.getModifiers() || [];
	for (const modifier of modifiers) {
		const text = modifier?.getText();
		if (
			["public", "private", "protected", "readonly", "static"].includes(text)
		) {
			const jsDoc = getJsDocOrCreate(classMemberNode);
			jsDoc.addTag({ tagName: text });
		}
	}
}

/**
 * Create class property initializer in constructor if it doesn't exist
 * so that documentation is preserved when transpiling
 */
function generateInitializerDocumentation(
	classPropertyNode: ObjectProperty
): void {
	const jsDoc = getJsDocOrCreate(classPropertyNode);
	if (!classPropertyNode.getStructure()?.initializer) {
		classPropertyNode.setInitializer("undefined");
	}
	const initializer = classPropertyNode.getStructure()?.initializer;
	if (initializer !== "undefined") {
		jsDoc.addTag({ tagName: "default", text: initializer });
	}
	if (classPropertyNode.getTypeNode()) {
		const type = sanitizeType(
			resolve_type(classPropertyNode, classPropertyNode.getTypeNode())
		);
		if (type) {
			jsDoc.addTag({ tagName: "type", text: `{${type}}` });
		}
	}
}

/** Document the class itself; at the moment just its extends signature */
function generateClassBaseDocumentation(classNode: ClassDeclaration) {
	const extendedClass = classNode.getExtends();
	if (extendedClass) {
		const jsDoc = getJsDocOrCreate(classNode);
		jsDoc.addTag({ tagName: "extends", text: extendedClass.getText() });
	}
}

/** Generate documentation for class members in general; either property or method */
function generateClassMemberDocumentation(
	classMemberNode: ClassMemberNode
): void {
	generateModifierDocumentation(classMemberNode);
	Node.isObjectProperty(classMemberNode) &&
		generateInitializerDocumentation(classMemberNode);
	Node.isMethodDeclaration(classMemberNode) &&
		generateFunctionDocumentation(classMemberNode);
}

/** Generate documentation for a class — itself and its members */
function generateClassDocumentation(classNode: ClassDeclaration): void {
	generateClassBaseDocumentation(classNode);
	classNode.getConstructors().map(generateParameterDocumentation);
	classNode.getMembers().forEach(generateClassMemberDocumentation);
}

/**
 * Generate @typedefs from type aliases
 * @return A JSDoc comment containing the typedef
 */
function generateTypedefDocumentation(
	typeNode: TypeAliasDeclaration,
	sourceFile: SourceFile
): string {
	// Create dummy node to assign typedef documentation to
	// (will be deleted afterwards)
	const name = typeNode.getName();
	let { type } = typeNode.getStructure();
	if (typeof type !== "string") return;
	type = sanitizeType(type);
	const dummyNode = sourceFile.addVariableStatement({
		declarations: [
			{
				name: `__dummy${name}`,
				initializer: "null",
			},
		],
	});
	const typeParams = typeNode.getTypeParameters();
	const jsDoc = dummyNode
		.addJsDoc({
			tags: [
				{
					tagName: "typedef",
					text: `{${type}} ${name}`,
				},
				...typeParams.map((param) => {
					const constraint = param.getConstraint();
					const defaultType = param.getDefault();
					const paramName = param.getName();
					const nameWithDefault = defaultType
						? `[${paramName}=${defaultType.getText()}]`
						: paramName;
					return {
						tagName: "template",
						text: `${
							constraint ? `{${constraint.getText()}} ` : ""
						}${nameWithDefault}`,
					};
				}),
			],
		})
		.getText();
	dummyNode.remove();
	return jsDoc;
}

/**
 * Generate documentation for object properties; runs recursively for nested objects
 * @param node
 * @param jsDoc
 * @param [name=""] The name to assign child docs to;
 *		"obj" will generate docs for "obj.val1", "obj.val2", etc
 * @param [topLevelCall=true] recursive functions are funky
 */
function generateObjectPropertyDocumentation(
	node: ObjectProperty,
	jsDoc: JSDoc,
	name = "",
	topLevelCall = true
): void {
	name = name || node.getName();
	if (!topLevelCall) name = `${name}.${node.getName()}`;
	let propType = node
		.getTypeNode()
		?.getText()
		?.replace(/\n/g, "")
		?.replace(/\s/g, "");
	propType = sanitizeType(propType);

	const isOptional =
		node.hasQuestionToken() ||
		node
			.getJsDocs()?.[0]
			?.getTags()
			?.some((tag) => tag.getTagName() === "optional");
	// Copy over existing description if there is one
	const existingPropDocs = node.getJsDocs()?.[0]?.getDescription() || "";
	const children = getChildProperties(node);

	if (children.length) propType = "Object";

	jsDoc.addTag({
		tagName: "property",
		text: `{${propType}} ${
			isOptional ? `[${name}]` : name
		} ${existingPropDocs}`,
	});

	if (children.length) {
		children
			.filter((child) => child !== node)
			.forEach((child) =>
				generateObjectPropertyDocumentation(child, jsDoc, name, false)
			);
	}
}

/** Generate @typedefs from interfaces */
function generateInterfaceDocumentation(
	interfaceNode: InterfaceDeclaration
): string {
	const name = interfaceNode.getName();
	const jsDoc = getJsDocOrCreate(interfaceNode);

	jsDoc.addTag({ tagName: "typedef", text: `{Object} ${name}` });
	interfaceNode.getProperties().forEach((prop) => {
		generateObjectPropertyDocumentation(prop, jsDoc);
	});
	return jsDoc.getFullText();
}

/**
 * Transpile.
 * @param src Source code to transpile
 * @param [filename=input.ts] Filename to use internally when transpiling (can be a path or a name)
 * @param [compilerOptions={}] Options for the compiler.
 * 		See https://www.typescriptlang.org/tsconfig#compilerOptions
 * @param [debug=false] Whether to log errors
 * @return Transpiled code (or the original source code if something went wrong)
 */
function transpile(
	src: string,
	filename = "input.ts",
	compilerOptions: object = {},
	debug = false
): string {
	// Useless variable to prevent comments from getting removed when code contains just
	// typedefs/interfaces, which get transpiled to nothing but comments
	const protectCommentsHeader =
		"const __tsToJsdoc_protectCommentsHeader = 1;\n";

	try {
		const project = new Project({
			compilerOptions: {
				target: ScriptTarget.ESNext,
				esModuleInterop: true,
				...compilerOptions,
			},
		});

		const code = protectCommentsHeader + src;
		// ts-morph throws a fit if the path already exists
		const sourceFile = project.createSourceFile(
			`${path.basename(filename, ".ts")}.ts-to-jsdoc.ts`,
			code
		);

		sourceFile.getClasses().forEach(generateClassDocumentation);

		const typedefs = sourceFile
			.getTypeAliases()
			.map((typeAlias) => generateTypedefDocumentation(typeAlias, sourceFile))
			.join("\n");

		const interfaces = sourceFile
			.getInterfaces()
			.map((interfaceNode) => generateInterfaceDocumentation(interfaceNode))
			.join("\n");

		sourceFile.getFunctions().forEach(generateFunctionDocumentation);

		sourceFile.getExportAssignments().forEach(generateExportDocumentation);

		const traverse = (node: Node) => {
			node.forEachChild(traverse);
			if (Node.isVariableStatement(node)) {
				generateVariableDocumentation(node);
			}
			// Do it after traversing childs because once a node is replaced, it's no longer traversable without re-getting it
			if (Node.isAsExpression(node)) {
				const type = resolve_type(node, node.getTypeNode());
				node.replaceWithText(
					"/** @type {" + type + "} */ (" + node.getExpression().getText() + ")"
				);
			}
		};
		sourceFile.forEachChild(traverse);

		let result = project
			.emitToMemory()
			?.getFiles()
			?.find((f) => f.filePath.includes(".ts-to-jsdoc."))?.text;
		if (result) {
			if (!result.startsWith(protectCommentsHeader)) {
				throw new Error(
					"Internal error: generated header is missing in output.\n\n" +
						`Output: ${JSON.stringify(
							`${result.slice(protectCommentsHeader.length + 100)} ...`
						)}`
				);
			}
			result = result.slice(protectCommentsHeader.length);
			result = result.replace(/(\S)\n((\t| )*\/\*\* @)/g, "$1\n\n$2"); // newline in front of jsdoc
			result = result.replace(
				/(\t| )*\/\*\* @([^\n]+\n[ \t]*\*)/gs,
				"$1/**\n$1 * @$2"
			); // newline after multiline jsdoc start
			result = result.replace(/ (\* @.+?) \*\//g, "$1\n */"); // newline before multiline jsdoc end
			return `${result}\n\n${typedefs}\n\n${interfaces}`;
		}
		throw new Error("Could not emit output to memory.");
	} catch (e) {
		debug && console.error(e);
		return src;
	}
	return src;
}

module.exports = transpile;
export default transpile;
