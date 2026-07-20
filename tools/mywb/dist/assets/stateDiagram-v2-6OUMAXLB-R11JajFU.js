import { s as styles_default, b as stateRenderer_v3_unified_default, a as stateDiagram_default, S as StateDB } from "./chunk-EX3LRPZG-bxok_POC.js";
import { _ as __name } from "./mermaid.core-Dd3hkX86.js";
import "./chunk-XXDRQBXY-DleOdaTg.js";
import "./chunk-VR4S4FIN-CgiCKkzs.js";
import "./chunk-32BRIVSS-DigLAhsm.js";
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
var diagram = {
  parser: stateDiagram_default,
  get db() {
    return new StateDB(2);
  },
  renderer: stateRenderer_v3_unified_default,
  styles: styles_default,
  init: /* @__PURE__ */ __name((cnf) => {
    if (!cnf.state) {
      cnf.state = {};
    }
    cnf.state.arrowMarkerAbsolute = cnf.arrowMarkerAbsolute;
  }, "init")
};
export {
  diagram
};
