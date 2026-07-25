import { g as getStyles, r as renderer, d as db } from "./chunk-MOJQB5TN-D7Ni_rR4.js";
import { p as populateCommonDb } from "./chunk-JWPE2WC7-CzxBH-2Q.js";
import { _ as __name, l as log } from "./mermaid.core-Dd3hkX86.js";
import { M as MermaidParseError, c as createRailroadServices } from "./cynefin-VYW2F7L2-CZfqpNLH.js";
import "./headless-document-C_mwntpw.js";
import "node:fs/promises";
import "node:os";
import "node:path";
import "fs";
import "fs/promises";
import "path";
import "stream/promises";
import "zlib";
import "util";
import "stream";
import "events";
import "crypto";
import "node:sqlite";
var langiumParser = createRailroadServices().Railroad.parser.LangiumParser;
var transformExpression = /* @__PURE__ */ __name((expr) => {
  switch (expr.$type) {
    case "RailroadTerminalExpr":
      return {
        type: "terminal",
        value: expr.value
      };
    case "RailroadNonTerminalExpr":
      return {
        type: "nonterminal",
        name: expr.name
      };
    case "RailroadSpecialExpr":
      return {
        type: "special",
        text: expr.text
      };
    case "RailroadSequenceExpr": {
      const elements = expr.elements.map(transformExpression);
      return elements.length === 1 ? elements[0] : { type: "sequence", elements };
    }
    case "RailroadChoiceExpr": {
      const alternatives = expr.alternatives.map(transformExpression);
      return alternatives.length === 1 ? alternatives[0] : { type: "choice", alternatives };
    }
    case "RailroadOptionalExpr":
      return {
        type: "optional",
        element: transformExpression(expr.element)
      };
    case "RailroadOneOrMoreExpr":
      return {
        type: "repetition",
        element: transformExpression(expr.element),
        min: 1,
        max: Infinity
      };
    case "RailroadZeroOrMoreExpr":
      return {
        type: "repetition",
        element: transformExpression(expr.element),
        min: 0,
        max: Infinity
      };
    default:
      throw new Error(`Unsupported railroad expression: ${expr.$type}`);
  }
}, "transformExpression");
var transformRule = /* @__PURE__ */ __name((rule) => {
  return {
    name: rule.name,
    definition: transformExpression(rule.definition)
  };
}, "transformRule");
var populateDb = /* @__PURE__ */ __name((ast) => {
  populateCommonDb(ast, db);
  if (ast.title) {
    db.setTitle(ast.title);
  }
  ast.rules.map((rule) => db.addRule(transformRule(rule)));
}, "populateDb");
var parser = {
  parse: /* @__PURE__ */ __name((input) => {
    db.clear();
    log.debug("[Railroad Parser] Starting Langium parse");
    const result = langiumParser.parse(input);
    if (result.lexerErrors.length > 0 || result.parserErrors.length > 0) {
      throw new MermaidParseError(result);
    }
    const ast = result.value;
    log.debug("[Railroad Parser] Parsed rules:", ast.rules.length);
    populateDb(ast);
    log.debug("[Railroad Parser] Parse complete");
  }, "parse"),
  parser: {
    yy: db
  }
};
var diagram = {
  parser,
  db,
  renderer,
  styles: getStyles
};
export {
  diagram
};
