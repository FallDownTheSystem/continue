import { SyntaxNode } from "web-tree-sitter";
import { ChunkWithoutID } from "../../index.js";
import { countTokensAsync } from "../../llm/countTokens.js";
import { getParserForFile } from "../../util/treeSitter.js";
import path from "node:path";

const commentSyntax: { [key: string]: string } = {
	"cpp": "//",
	"hpp": "//",
	"cc": "//",
	"cxx": "//",
	"hxx": "//",
	"cp": "//",
	"hh": "//",
	"inc": "//",
	"ccm": "//",
	"c++m": "//",
	"cppm": "//",
	"cxxm": "//",
	"cs": "//",
	"c": "//",
	"h": "//",
	"css": "/* */",
	"php": "//",
	"phtml": "//",
	"php3": "//",
	"php4": "//",
	"php5": "//",
	"php7": "//",
	"phps": "//",
	"php-s": "//",
	"bash": "#",
	"sh": "#",
	"json": "//",
	"ts": "//",
	"mts": "//",
	"cts": "//",
	"tsx": "//",
	"vue": "<!-- -->",
	"elm": "--",
	"js": "//",
	"jsx": "//",
	"mjs": "//",
	"cjs": "//",
	"py": "#",
	"pyw": "#",
	"pyi": "#",
	"el": ";;",
	"emacs": ";;",
	"ex": "#",
	"exs": "#",
	"go": "//",
	"eex": "<!-- -->",
	"heex": "<!-- -->",
	"leex": "<!-- -->",
	"html": "<!-- -->",
	"htm": "<!-- -->",
	"java": "//",
	"lua": "--",
	"ocaml": "(* *)",
	"ml": "(* *)",
	"mli": "(* *)",
	"ql": "//",
	"res": "//",
	"resi": "//",
	"rb": "#",
	"erb": "#",
	"rs": "//",
	"rdl": "//",
	"toml": "#",
	"sol": "//",
	"jl": "#",
	"swift": "//",
	"kt": "//",
	"scala": "//",
};

const NESTED_NODE_TYPES = ["_declaration", "_definition", "function_expression", "function_item"];
function shouldIncludeInContext(node: SyntaxNode): boolean {
	return NESTED_NODE_TYPES.some(x => node.type.includes(x));
}

const BODY_NODE_TYPES = ["block", "statement_block", "class_body", "declaration_list"];
// Get the text up to the body of the node to include in the context.
function getNodeContext(node: SyntaxNode, code: string, commentSyntax: string): { code: string, row: number } {
	let endIndex = node.endIndex;
	let endRow = node.endPosition.row;
	for (const child of node.children) {
		if (BODY_NODE_TYPES.includes(child.type)) {
			endIndex = child.startIndex;
			endRow = child.startPosition.row;
			break;
		}
	}
	return {
		code: code
			.slice(node.startIndex, endIndex)
			.split('\n')
			.map(line => `${commentSyntax} ${line}`)
			.join('\n')
			.trim(),
		row: endRow
	};
}

function formatContext(path: string[]): string {
	if (path.length === 0) return "";
	return path.join('\n') + '\n';
}

export async function* codeChunker(
	filepath: string,
	contents: string,
	maxChunkSize: number,
): AsyncGenerator<ChunkWithoutID> {
	if (contents.trim().length === 0) {
		return;
	}
	const lines = contents.split('\n');
	const parser = await getParserForFile(filepath);
	const extension = path.extname(filepath).slice(1);
	const comment = commentSyntax[extension] ?? "//";

	if (parser === undefined) {
		console.warn(`Failed to load parser for file ${filepath}: `);
		return;
	}
	const tree = parser.parse(contents);
	let startLine = 1;
	let currentContent = "";
	const lineTokens = await Promise.all(lines.map(async l => {
		return {
			line: l,
			tokenCount: await countTokensAsync(l),
		};
	}));
	let lastContextLine = -1;

	async function getContextForLine(node: SyntaxNode, lineNumber: number, code: string, contextPath: string[]): Promise<string[]> {
		if (node.startPosition.row > lineNumber || node.endPosition.row < lineNumber) {
			return contextPath;
		}
		if (shouldIncludeInContext(node) && node.startPosition.row > lastContextLine) {
			const nodeContext = getNodeContext(node, code, comment);
			lastContextLine = nodeContext.row;
			contextPath.push(nodeContext.code);
		}
		for (const child of node.children) {
			contextPath = await getContextForLine(child, lineNumber, code, contextPath);
		}
		return contextPath;
	}

	let chunkTokens = 0;
	let contextPath: string[] = [];
	for (let i = 0; i < lineTokens.length; i++) {
		const { line, tokenCount } = lineTokens[i];
		const contextString = formatContext(contextPath);
		const contextTokens = await countTokensAsync(contextString);
		if (chunkTokens + tokenCount + contextTokens > maxChunkSize - 5) {
			yield {
				content: contextString + currentContent,
				startLine,
				endLine: i,
			};
			startLine = i + 1;
			currentContent = "";
			chunkTokens = 0;
			// We need to set the context for the next chunk
			contextPath = await getContextForLine(tree.rootNode, i, contents, []);
		}
		if (tokenCount < maxChunkSize) {
			currentContent += `${line}\n`;
			chunkTokens += tokenCount + 1;
		}
	}
	// Add the final chunk
	if (currentContent.trim()) {
		const contextString = formatContext(contextPath);
		yield {
			content: contextString + currentContent,
			startLine: startLine,
			endLine: lines.length,
		};
	}
}

