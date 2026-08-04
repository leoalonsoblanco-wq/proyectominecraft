/* ============================================================
   Worker de mallado de chunks (VoxelCraft)
   No usa THREE.js: recibe datos de bloques (Uint8Array) y
   devuelve arrays tipados listos para BufferGeometry.
   También calcula la luz por bloque (cielo + fuentes) para que
   las cuevas y espacios cerrados se vean más oscuros que el exterior.
   ============================================================ */
let CX = 16, CY = 80, CZ = 16, CXZ = 256, BEDROCK = 11;
let BLOCKS = null;   // [ null, {opaque,layer,t:[a,b,c],light}, ... ] indexado por id de bloque
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

// curva de brillo por nivel de luz (0..15 -> 0..1), nunca del todo negra
const LIGHT_CURVE = [];
for(let i=0;i<16;i++) LIGHT_CURVE[i] = Math.max(0.06, Math.pow(0.82, 15-i));

/* --- luz por bloque: cielo abierto (15) + fuentes emisoras, propagadas por BFS ---
   Limitación asumida (versión simplificada): la propagación no cruza el borde del
   chunk hacia los vecinos, así que puede haber una costura sutil de luz en el borde
   de cuevas que sigan hacia el chunk de al lado; fuera del chunk se asume luz plena
   para no oscurecer artificialmente los bordes visibles. */
function computeLight(data){
  const light = new Uint8Array(CX*CY*CZ);
  const isOpaqueLocal = (x,y,z) => { const b=data[y*CXZ+z*CX+x]; return b!==0 && BLOCKS[b].opaque; };
  const qi = [];
  let qHead = 0;
  function push(x,y,z,v){
    const i = y*CXZ+z*CX+x;
    if (v <= light[i]) return;
    light[i] = v;
    qi.push(i);
  }
  // luz solar: todo lo que quede por encima del bloque opaco más alto de cada columna
  for(let z=0; z<CZ; z++) for(let x=0; x<CX; x++){
    let topY = 0;
    for(let y=CY-1; y>=0; y--){ if (isOpaqueLocal(x,y,z)){ topY = y+1; break; } }
    for(let y=topY; y<CY; y++) push(x,y,z,15);
  }
  // fuentes de luz (bloques que emiten, p. ej. la piedra luminosa)
  for(let i=0;i<data.length;i++){
    const b = data[i];
    if (b && BLOCKS[b].light) push(i%CX, (i/CXZ)|0, ((i/CX)|0)%CZ, BLOCKS[b].light);
  }
  // propagación BFS (decae 1 por bloque, no atraviesa bloques opacos)
  while (qHead < qi.length){
    const i = qi[qHead++];
    const v = light[i];
    if (v <= 1) continue;
    const nv = v-1;
    const x = i%CX, z = ((i/CX)|0)%CZ, y = (i/CXZ)|0;
    if (x>0    && !isOpaqueLocal(x-1,y,z)) push(x-1,y,z,nv);
    if (x<CX-1 && !isOpaqueLocal(x+1,y,z)) push(x+1,y,z,nv);
    if (y>0    && !isOpaqueLocal(x,y-1,z)) push(x,y-1,z,nv);
    if (y<CY-1 && !isOpaqueLocal(x,y+1,z)) push(x,y+1,z,nv);
    if (z>0    && !isOpaqueLocal(x,y,z-1)) push(x,y,z-1,nv);
    if (z<CZ-1 && !isOpaqueLocal(x,y,z+1)) push(x,y,z+1,nv);
  }
  return light;
}

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
  const light = computeLight(data);
  // fuera del chunk no tenemos luz calculada: usamos la celda válida más cercana
  // dentro del propio chunk (evita "paredes" brillantes artificiales en el borde
  // de cuevas subterráneas que continúan en el chunk vecino)
  const getLight = (x,y,z) => {
    const cx = x<0 ? 0 : (x>=CX ? CX-1 : x);
    const cy = y<0 ? 0 : (y>=CY ? CY-1 : y);
    const cz = z<0 ? 0 : (z>=CZ ? CZ-1 : z);
    return light[cy*CXZ+cz*CX+cx];
  };

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
      const faceLight = LIGHT_CURVE[getLight(bx,by,bz)];
      const base = t.n;
      for(let i=0;i<4;i++){
        const c = F.corners[i];
        t.pos.push(x+c[0], y+c[1], z+c[2]);
        t.nor.push(d[0], d[1], d[2]);
        t.uv.push(uvq[0] + UVC[i][0]*(uvq[2]-uvq[0]), uvq[1] + UVC[i][1]*(uvq[3]-uvq[1]));
        const l = AOL[ao[i]] * faceLight;
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
