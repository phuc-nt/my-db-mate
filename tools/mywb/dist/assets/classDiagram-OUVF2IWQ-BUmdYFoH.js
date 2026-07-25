import { s as styles_default, c as classRenderer_v3_unified_default, a as classDiagram_default, C as ClassDB } from "./chunk-V7JOEXUC-OZxY4-fT.js";
import { _ as __name } from "./mermaid.core-Dd3hkX86.js";
import "./chunk-5VM5RSS4-CAta_qSm.js";
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
  parser: classDiagram_default,
  get db() {
    return new ClassDB();
  },
  renderer: classRenderer_v3_unified_default,
  styles: styles_default,
  init: /* @__PURE__ */ __name((cnf) => {
    if (!cnf.class) {
      cnf.class = {};
    }
    cnf.class.arrowMarkerAbsolute = cnf.arrowMarkerAbsolute;
  }, "init")
};
export {
  diagram
};
