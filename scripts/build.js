import { build } from "esbuild";
import { stat, writeFile, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const result = await build({
  entryPoints: ["src/index.js"],
  outfile: "dist/ulda-library.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  metafile: true,
  banner: { js: '/*! ULDA Auth: SDK and dependency licenses in THIRD_PARTY_LICENSES.md. */' },
});
if (
  Object.keys(result.metafile.inputs).some((path) => /(^|\/)tests\//.test(path))
)
  throw new Error("Test server must not enter browser bundle.");
// Preserve original license texts for the packages actually included by esbuild.
const dependencyRoots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.replaceAll('\\', '/').split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) continue;
  // Some packages have named package.json files in build/esm without licenses.
  const end = at + (parts[at + 1].startsWith('@') ? 3 : 2);
  dependencyRoots.add(resolve(...parts.slice(0, end)));
}
const notices = ['# SDK and third-party licenses', '', '## ULDA Auth SDK', '', await readFile('LICENSE.md', 'utf8'), '', '## Included dependencies', '', 'Their licenses are separate from the SDK license.', ''];
for (const folder of [...dependencyRoots].sort()) {
  const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
  const files = (await readdir(folder)).filter(file => /^licen[cs]e(?:\.(?:md|txt))?$/i.test(file)).sort();
  if (!files.length) throw new Error(`Missing license text for bundled dependency: ${pkg.name}`);
  notices.push(`## ${pkg.name}@${pkg.version}`, '');
  for (const file of files) notices.push(await readFile(join(folder, file), 'utf8'), '');
}
await writeFile('dist/THIRD_PARTY_LICENSES.md', notices.join('\n'));
// Remove only known generated copies from older builds; npm auto-includes nested README/LICENSE.
for (const file of ['LICENSE.md', 'MANIFEST.md', 'SECURITY.md', 'README.md'])
  await unlink(`dist/${file}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
const bytes = await readFile("dist/ulda-library.js");
const info = {
  bytes: (await stat("dist/ulda-library.js")).size,
  gzipBytes: gzipSync(bytes).length,
};
await writeFile("dist/size.json", JSON.stringify(info, null, 2));
console.log(JSON.stringify(info));
