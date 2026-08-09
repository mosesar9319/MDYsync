// Solves for and applies a 2D projective (homography) transform from 4
// point correspondences -- the standard technique document-scanner apps
// use to map a photographed page's four corners onto its "flattened"
// rectangular coordinate space (or, as used here, the reverse: mapping the
// canonical page's normalized word-box coordinates onto wherever the real
// photographed page's corners actually are).
//
// Deliberately plain linear algebra, not a dependency on OpenCV or any
// image-processing library -- this project's Netlify Functions have never
// had an npm dependency before (see package.json), and a 4-point homography
// is a well-defined, bounded piece of math that doesn't need one.

/**
 * Solves the 8 unknowns of a projective transform mapping each `from[i]`
 * point to the corresponding `to[i]` point (exactly 4 pairs; a homography
 * has 8 degrees of freedom, and 4 point correspondences give exactly 8
 * equations). Returns a 3x3 matrix (row-major, 9 numbers, last entry fixed
 * to 1) usable by `applyHomography`.
 */
export function solveHomography(from, to) {
  if (from.length !== 4 || to.length !== 4) {
    throw new Error('solveHomography needs exactly 4 point correspondences.');
  }
  // Build the 8x8 linear system Ax = b for [a,b,c,d,e,f,g,h] where:
  //   x' = (a*x + b*y + c) / (g*x + h*y + 1)
  //   y' = (d*x + e*y + f) / (g*x + h*y + 1)
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [xp, yp] = to[i];
    A.push([x, y, 1, 0, 0, 0, -x * xp, -y * xp]);
    b.push(xp);
    A.push([0, 0, 0, x, y, 1, -x * yp, -y * yp]);
    b.push(yp);
  }
  const solved = gaussianEliminate(A, b);
  const [a, bb, c, d, e, f, g, h] = solved;
  return [a, bb, c, d, e, f, g, h, 1];
}

/** Applies a 3x3 homography (as returned by solveHomography) to a point. */
export function applyHomography(matrix, x, y) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const w = g * x + h * y + i;
  return [(a * x + b * y + c) / w, (d * x + e * y + f) / w];
}

/** Plain Gaussian elimination with partial pivoting for a square system. */
function gaussianEliminate(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (Math.abs(M[col][col]) < 1e-10) {
      throw new Error('Degenerate point correspondences -- cannot solve homography.');
    }
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col] / M[col][col];
      for (let c = col; c <= n; c++) M[row][c] -= factor * M[col][c];
    }
  }
  // Full (Gauss-Jordan) elimination above already zeroed every off-diagonal
  // entry, so each row's solution is just its augmented column over its
  // own pivot.
  return M.map((row, i) => row[n] / row[i]);
}
