// Exports the collision layout, machines and spawns of a GameMaker room to
// the JSON the server reads.
//
//   npm run export-map -- "../Factory Rebellion Game" Multiplayer1
//
// Spawn points are chosen by hand in src/assets/maps/<room>.spawns.json (the
// room has no spawn markers); everything else comes from the project itself.
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { exportFromProject } from '../src/match/map-export';

const [projectDir = '../Factory Rebellion Game', room = 'Multiplayer1'] =
  process.argv.slice(2);
const mapsDir = path.resolve(__dirname, '../src/assets/maps');
const file = room.toLowerCase();

const spawns = JSON.parse(
  readFileSync(path.join(mapsDir, `${file}.spawns.json`), 'utf8'),
);
const map = exportFromProject(path.resolve(projectDir), room, spawns);

writeFileSync(
  path.join(mapsDir, `${file}.json`),
  JSON.stringify(map, null, 2) + '\n',
);
console.log(
  `exported ${room}: ${map.colliders.length} colliders, ${map.machines.length} machines -> src/assets/maps/${file}.json`,
);
