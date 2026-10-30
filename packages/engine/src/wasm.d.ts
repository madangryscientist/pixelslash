/** A `.wasm` import is compiled by the bundler (workerd); only `diff-module.workerd.ts` makes one. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
