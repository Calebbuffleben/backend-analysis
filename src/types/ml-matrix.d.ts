declare module "ml-matrix" {
  export class Matrix {
    constructor(matrix: number[][]);
    mean(): number;
    mean(by: "row" | "column"): number[];
  }
}
