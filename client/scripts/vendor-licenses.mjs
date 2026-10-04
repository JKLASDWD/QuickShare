import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Include the SDK's runtime dependency tree, even if Rollup removes some modules.
// Fail closed when a package stops shipping its legal files.
export function collectVendorLicenses(packageDirectory, destination) {
  const seen = new Set();
  const records = [];
  const upstream = fileURLToPath(new URL('../../licenses/', import.meta.url));
  function visit(directory) {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const id = `${pkg.name}@${pkg.version}`;
    if (seen.has(id)) return;
    seen.add(id);
    const folder = id.replace(/[^a-zA-Z0-9._-]/g, '_');
    const output = path.join(destination, folder);
    fs.mkdirSync(output, { recursive: true });
    let legalDirectory = directory;
    let legalFiles = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /licen[cs]e|copying|notice/i.test(entry.name))
      .map(entry => entry.name);
    // protobuf 1.10.1 omits legal files from its npm tarball. Keep the official
    // versioned license and the Google BSD notice in the public source tree.
    if (!legalFiles.length && pkg.name === '@bufbuild/protobuf') {
      legalDirectory = path.join(upstream, `bufbuild-protobuf-${pkg.version}`);
      legalFiles = fs.readdirSync(legalDirectory);
    }
    if (!pkg.license || !legalFiles.length) throw Error(`Missing vendor license: ${id}`);
    for (const filename of legalFiles) {
      fs.copyFileSync(path.join(legalDirectory, filename), path.join(output, filename));
    }
    records.push({
      name: pkg.name, version: pkg.version, license: pkg.license,
      repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url,
      author: pkg.author,
      files: legalFiles.map(filename => `${folder}/${filename}`),
    });
    for (const dependency of Object.keys(pkg.dependencies || {}).sort()) {
      let parent = directory;
      while (!fs.existsSync(path.join(parent, 'node_modules', dependency, 'package.json'))) {
        const next = path.dirname(parent);
        if (parent === next) throw Error(`Missing runtime dependency: ${dependency}`);
        parent = next;
      }
      visit(path.join(parent, 'node_modules', dependency));
    }
  }
  visit(packageDirectory);
  records.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify(records, null, 2)}\n`);
  console.log(`[fetch-vendor] preserved ${records.length} runtime dependency license records`);
}
