import type { TextMatchTransformer } from "@lexical/markdown";

/** Label migrations escape hashes; Lexical's default importer only unescapes
 * emphasis/code punctuation. Consume this escape in prose, never inside code.
 */
export const ESCAPED_HASHTAG_TRANSFORMER: TextMatchTransformer = {
  dependencies: [],
  type: "text-match",
  regExp: /$^/,
  importRegExp: /(?<!\\)\\#(?=[\p{L}\p{N}_\[])/u,
  replace: (node) => { node.setTextContent("#"); return node; },
};
