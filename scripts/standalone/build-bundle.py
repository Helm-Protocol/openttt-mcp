#!/usr/bin/env python3
"""Package already-built artifacts. No cloud calls, downloads or service changes."""
import argparse, hashlib, json, shutil, subprocess, tarfile
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--rust-bin',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args()
root=Path(__file__).resolve().parents[2]
if a.output.exists(): raise SystemExit('Output exists; choose a new path')
if not a.rust_bin.is_file(): raise SystemExit('Supply the reviewed Linux x86_64 Rust artifact')
files=['demo/gate_challenge.mjs','demo/rust_verifier.mjs','demo/strict_json.mjs','demo/memorydb_replay.mjs','dist/pot_record_v2.js','LICENSE','infra/memorydb/README.md','infra/memorydb/main.tf']
files += [str(x.relative_to(root)) for x in (root/'infra/tttps-xdp').iterdir() if x.is_file()]
for f in files:
 if not (root/f).is_file(): raise SystemExit('Missing build input: '+f)
a.output.mkdir(parents=True)
for f in files:
 dest=a.output/f;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/f,dest)
for f in ['install-local.sh','run-local.sh']:
 shutil.copy2(root/'scripts/standalone'/f,a.output/f)
shutil.copy2(root/'docs/ami-upgrade/README.md',a.output/'README.md')
shutil.copy2(root/'docs/draft13/appendix-b-generated.json',a.output/'appendix-b-generated.json')
(a.output/'bin').mkdir();shutil.copy2(a.rust_bin,a.output/'bin/openttt-draft13-reference')
(a.output/'package.json').write_text(json.dumps({'name':'tttps-instance-reference','private':True,'type':'commonjs','engines':{'node':'>=18'}},indent=2)+'\n')
provenance={'source_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'source_tree_status':subprocess.check_output(['git','status','--short'],cwd=root,text=True).strip(),'rust_sha256':hashlib.sha256(a.rust_bin.read_bytes()).hexdigest(),'scope':'Linux x86_64 reference; MemoryDB inert; XDP activation explicit; no AMI mutation'}
(a.output/'BUILD-PROVENANCE.json').write_text(json.dumps(provenance,indent=2)+'\n')
manifest=''.join(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+str(f.relative_to(a.output))+'\n' for f in sorted(a.output.rglob('*')) if f.is_file())
(a.output/'MANIFEST.sha256').write_text(manifest)
archive=a.output.with_suffix('.tar.gz')
with tarfile.open(archive,'w:gz') as t:t.add(a.output,arcname='tttps-instance-reference')
print(json.dumps({'archive':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'manifest_sha256':hashlib.sha256(manifest.encode()).hexdigest()},indent=2))
