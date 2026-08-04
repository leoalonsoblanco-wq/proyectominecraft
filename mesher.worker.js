/* ============================================================
   Worker de mallado de chunks (VoxelCraft)
   No usa THREE.js: recibe datos de bloques (Uint8Array) y
   devuelve arrays tipados listos para BufferGeometry.
   ============================================================ */
let CX = 16, CY = 80, CZ = 16, CXZ = 256, BEDROCK = 11;
let BLOCKS = null;   // [ null, {opaque,layer,t:[a,b,c]}, ... ] indexado por id de bloque
let TILEUV = null;   // [ [u0,v0,u1,v1], ... ] indexado por índice de tile del atlas

const FACES = [
  { dir:[-1,0,0], corners:[[0,0,0],[0,0,1],[0,1,0],[0,1,1]] },
  { dir:[ 1,0,0], corners:[[1,0,1],[1,0,0],[1,1,1],[1,1,0]] },
  { dir:[0,-1,0], corners:[[0,0,0],[1,0,0],[0,0,1],[1,0,1]] },
  { dir:[0, 1,0], corners:[[0,1,1],[1,1,1],[0,1,0],[1,1,0]] },
  { dir:[0,0,-1], corners:[[1,0,0],[0,0,0],[1,1,0],[0,1,0]] },
  { dir:[0,0, 1], corners:[[0,0,1],[1,0,1],[0,1,1],[1,1,1]] },
];
const UVC = [[0,0],[1,0],[0,1],[1,1]];
const AOL = [0.48, 0.68, 0.85, 1.0];

for (const F of FACES){
  const ax = [0,1,2].filter(a => F.dir[a] === 0);
  F.ao = F.corners.map(c => {
    const s1 = c[ax[0]]*2-1, s2 = c[ax[1]]*2-1;
    const o1=[0,0,0]; o1[ax[0]] = s1;
    const o2=[0,0,0]; o2[ax[1]] = s2;
    return [o1, o2, [o1[0]+o2[0], o1[1]+o2[1], o1[2]+o2[2]]];
  });
}
const tileOf = (B,f) => f===3 ? B.t[0] : (f===2 ? B.t[2] : B.t[1]);

function buildMeshData(data, neighbors){
  function get(x,y,z){
    if (y<0) return BEDROCK;
    if (y>=CY) return 0;
    let ox=0, oz=0;
    if (x<0){ ox=-1; x+=CX; } else if (x>=CX){ ox=1; x-=CX; }
    if (z<0){ oz=-1; z+=CZ; } else if (z>=CZ){ oz=1; z-=CZ; }
    return neighbors[(ox+1)*3+(oz+1)][y*CXZ + z*CX + x];
  }
  const opq = (x,y,z) => { const b=get(x,y,z); return (b!==0 && BLOCKS[b].opaque) ? 1 : 0; };

  const buf = [0,1,2].map(()=>({ pos:[], nor:[], uv:[], col:[], idx:[], n:0 }));

  for(let y=0;y<CY;y++) for(let z=0;z<CZ;z++) for(let x=0;x<CX;x++){
    const id = data[y*CXZ + z*CX + x];
    if (!id) continue;
    const B = BLOCKS[id];
    const t = buf[B.layer];
    for(let f=0;f<6;f++){
      const F = FACES[f], d = F.dir;
      const bx = x+d[0], by = y+d[1], bz = z+d[2];
      const nid = get(bx,by,bz);
      if (nid){
        const N = BLOCKS[nid];
        if (N.opaque) continue;
        if (nid === id) continue;                       // caras internas del mismo material
        if (B.layer===2 && N.layer===2) continue;
      }
      const uvq = TILEUV[tileOf(B,f)];
      const ao = [0,0,0,0];
      for(let i=0;i<4;i++){
        const [o1,o2,oc] = F.ao[i];
        const s1 = opq(bx+o1[0], by+o1[1], bz+o1[2]);
        const s2 = opq(bx+o2[0], by+o2[1], bz+o2[2]);
        ao[i] = (s1 && s2) ? 0 : 3 - (s1 + s2 + opq(bx+oc[0], by+oc[1], bz+oc[2]));
      }
      const base = t.n;
      for(let i=0;i<4;i++){
        const c = F.corners[i];
        t.pos.push(x+c[0], y+c[1], z+c[2]);
        t.nor.push(d[0], d[1], d[2]);
        t.uv.push(uvq[0] + UVC[i][0]*(uvq[2]-uvq[0]), uvq[1] + UVC[i][1]*(uvq[3]-uvq[1]));
        const l = AOL[ao[i]];
        t.col.push(l,l,l);
      }
      if (ao[0] + ao[3] > ao[1] + ao[2])
        t.idx.push(base, base+1, base+3, base, base+3, base+2);
      else
        t.idx.push(base, base+1, base+2, base+2, base+1, base+3);
      t.n += 4;
    }
  }
  return buf;
}

onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init'){
    CX=msg.CX; CY=msg.CY; CZ=msg.CZ; CXZ=msg.CXZ; BEDROCK=msg.BEDROCK;
    BLOCKS = msg.BLOCKS; TILEUV = msg.TILEUV;
    return;
  }
  if (msg.type === 'mesh'){
    const buf = buildMeshData(msg.data, msg.neighbors);
    const layers = buf.map(t => ({
      pos: new Float32Array(t.pos),
      nor: new Float32Array(t.nor),
      uv:  new Float32Array(t.uv),
      col: new Float32Array(t.col),
      idx: new Uint32Array(t.idx),
    }));
    const transfer = [];
    for(const L of layers) transfer.push(L.pos.buffer, L.nor.buffer, L.uv.buffer, L.col.buffer, L.idx.buffer);
    postMessage({ type:'meshed', id: msg.id, cx: msg.cx, cz: msg.cz, layers }, transfer);
  }
};
