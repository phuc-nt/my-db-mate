import { aj as Utils, ak as Color } from "./mermaid.core-Dd3hkX86.js";
const channel = (color, channel2) => {
  return Utils.lang.round(Color.parse(color)[channel2]);
};
export {
  channel as c
};
