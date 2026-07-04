// onnxruntime-node 1.19.x não expõe os types via package "exports" para o
// nosso moduleResolution — a API real vive em onnxruntime-common.
declare module 'onnxruntime-node' {
  export * from 'onnxruntime-common';
}
