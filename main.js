
const TILE_SIZE = 128; // tile size in px
const COL_COUNT = 12;
const ROW_COUNT = 6;
const DAM_STRENGTH = 4;
const FLOOD_ANIM_DURATION = 1300; // should match CSS animation durations
const BUILD_DAM_ANIM_DURATION = 1100;
const CUT_WOOD_ANIM_DURATION = 500;

const sounds = {};

const resources = {
  workers: 5,
  wood: 2,
  time: 7
};

const placedWorkers = {}; // key is i|j

const map = [];
let container;
let endTurnButton;
let workerCounter, woodCounter, timerCounter;

let currentLevel = 0;
const levelData = [
  {
    map: [
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 2],
      [0, 4, 4, 0, 2, 2, 2, 2, 0, 0, 0, 2],
      [0, 4, 4, 4, 3, 0, 0, 2, 2, 2, 0, 0],
      [1, 1, 1, 1, 1, 3, 0, 2, 0, 0, 0, 5],
      [0, 1, 1, 3, 3, 0, 0, 0, 0, 0, 5, 5],
      [1, 3, 3, 6, 6, 0, 0, 0, 0, 5, 5, 5]
    ],
    objectives: [
      {x: 6, y: 3},
      {x: 0, y: 2},
    ]
  }
];

// This var lists all the known tile types.
// It is used both as a type checking aid,
// as well as an index->type mapping for the level layouts,
// so its order is also important.
const tileTypes = ['grass', 'water', 'swamp', 'dam', 'highground', 'woods', 'stillwater'];

// when true, tile transitions only update the internal state immediately,
// dom node transitions are deferred - to be updated manually in an animation
let deferTransitions = false;
// pendingTransitions has a collection for each diagonal to create a wave effect
const pendingTransitions = [];

function emptyPendingTransitionGroups() {
  // truncate to empty const array - hopefully this works everywhere...
  pendingTransitions.length = 0;
  for (let i=0; i<ROW_COUNT+COL_COUNT; i++) {
    pendingTransitions.push([]);
  }
}
emptyPendingTransitionGroups();

// TODO: forEachTileInMap util?
function updateTileCounters() {
  for (let ri = 0; ri < map.length; ri++) {
    const row = map[ri];
    for (let ci = 0; ci < row.length; ci++) {
      const cell = row[ci];
      console.assert(tileTypes.includes(cell.type));
      if (cell.type === 'dam' || cell.objectiveNode) {
        console.assert(!(cell.type === 'dam' && cell.objectiveNode));
        if (!cell.counterNode) {
          const counter = $('<div />').addClass('round-counter');
          counter.appendTo(container);
          cell.counterNode = counter;
          cell.counterNode.css({
            top: cell.domNode.position().top,
            left: cell.domNode.position().left,
            width: TILE_SIZE,
            height: TILE_SIZE,
            'font-size': TILE_SIZE * 0.4 + 'px',
            'line-height': TILE_SIZE + 12 + 'px'
          });
        }
        if (cell.type === 'dam') {
          cell.counterNode.text(cell.strength);
        } else {
          cell.counterNode.text(resources.time);
        }
      }
    }
  }
}

function updateResources() {
  workerCounter.text(resources.workers);
  woodCounter.text(resources.wood);
  timerCounter.text(resources.time);
}

function getNeighbours(i, j) {
  // we also support passing a tile object
  if (typeof i === 'object') {
    console.assert(i.hasOwnProperty('i') && i.hasOwnProperty('j'));
    j = i.j;
    i = i.i;
  }
  console.assert(i >= 0 && j >= 0);

  const neighbours = [];
  if (i-1 >= 0) {
    // tile above
    neighbours.push(map[i-1][j]);
  }
  if (j+1 < COL_COUNT) {
    // tile to the right
    neighbours.push(map[i][j+1]);
  }
  if (i+1 < ROW_COUNT) {
    // tile below
    neighbours.push(map[i+1][j]);
  }
  if (j-1 >= 0) {
    // tile to the left
    neighbours.push(map[i][j-1]);
  }

  return neighbours;
}

function setTileType(tile, type) {
  // Changes the tile's internal type and its DOM node class to the given type.
  // Note that you have to manage other side-effects (such as setting flags) manually.
  console.assert(tileTypes.includes(type));
  if (tile.type === type) {
    console.assert(false, 'invalid transform: ' + type, tile);
    return;
  }
  tile.originalType = tile.type;
  tile.type = type;
  if (deferTransitions) {
    const diagonalIndex = tile.i + tile.j;
    pendingTransitions[diagonalIndex].push(tile);
  } else {
    tile.domNode.removeClass(tileTypes);
    tile.domNode.addClass(type);
  }
}

function floodTile(tile) {
  console.assert(tile.type !== 'water');

  if (tile.objectiveNode) {
    const gameOverDialog = $('<div />').addClass('dialog').appendTo(container);
    gameOverDialog.text('Game over!');
  }

  setTileType(tile, 'water');
  tile.updated = true;
}

function removeDam(tile) {
  delete tile.strength;
  tile.counterNode.remove();
  delete tile.counterNode;
  // TODO: add support for putting back the originally covered tile
  setTileType(tile, 'grass');
}

function countNeighboursOfType(tile, type) {
  console.assert(tileTypes.includes(type));
  const neighbours = getNeighbours(tile);
  let count = 0;
  neighbours.forEach(n => {
    if (n.type === type) {
      count++;
    }
  });
  return count;
}

function floodNeighbours(i, j) {
  // floods the neighbouring tiles, considers dams and applies decay
  for (const tile of getNeighbours(i, j)) {
    if (tile.type === 'grass') {
      floodTile(tile);
    }
    if (tile.type === 'swamp') {
      floodSwamp(tile);
    }
    if (tile.type === 'dam') {
      tile.strength -= 1;
      if (tile.strength <= countNeighboursOfType(tile, 'water')) {
        tile.counterNode.addClass('failing');
      }
      if (tile.strength === 0) {
        removeDam(tile);
      }
    }
    if (tile.type === 'stillwater') {
      let protected = false;
      // protected by any dam to the left
      if (tile.j > 0) {
        protected = (map[tile.i][tile.j-1].type === 'dam');
      }
      // OR any adjacent highground
      protected = protected || countNeighboursOfType(tile, 'highground') > 0;
      if (!protected) {
        floodTile(tile);
      }
    }
  }
}

function floodSwamp(tile) {
  // floods every cell in a contigous swamp region starting at tile
  console.assert(tile.type === 'swamp');
  console.assert(!tile.explored);
  const swamp = [tile];
  function hasUnexplored(swamp) {
    return swamp.some(function(tile) {
      return !tile.explored;
    });
  }
  // TODO: add failsafe iter count to while condition
  while(hasUnexplored(swamp)) {
    swamp.forEach(tile => {
      getNeighbours(tile).forEach(neighbour => {
        if (neighbour.type === 'swamp' && !swamp.includes(neighbour)) {
          swamp.push(neighbour);
        }
      });
      tile.explored = true;
    });
  }

  // flood and clear explored markers
  swamp.forEach(tile => {
    console.assert(tile.type === 'swamp', tile);
    floodTile(tile);
    delete tile.explored;
  });
}

function updateMap() {
  // updates the map types in-place by applying flooding rules

  for (let ri = 0; ri < map.length; ri++) {
    const row = map[ri];
    for (let ci = 0; ci < row.length; ci++) {
      const cell = row[ci];
      console.assert(tileTypes.includes(cell.type));

      if (cell.type === 'water' && !cell.updated) {
        floodNeighbours(ri, ci);
      }
    }
  }

  // clear updated flags
  for (let ri = 0; ri < map.length; ri++) {
    const row = map[ri];
    for (let ci = 0; ci < row.length; ci++) {
      const cell = row[ci];
      console.assert(tileTypes.includes(cell.type));
      delete cell.updated;
    }
  }
}

function removeWorker(tile) {
  delete tile.hasWorker;
  tile.workerNode.remove();
  delete tile.workerNode;
  resources.workers++;
  if (tile.type !== 'woods') {
    resources.wood++;
  }

  const workerKey = tile.i + '|' + tile.j;
  console.assert(workerKey in placedWorkers);
  delete placedWorkers[workerKey];
}

function placeWorker(tile) {
  const workerKey = tile.i + '|' + tile.j;
  console.assert(!(workerKey in placedWorkers));
  placedWorkers[workerKey] = true;

  resources.workers--;
  if (tile.type !== 'woods') {
    resources.wood--;
  }
  tile.hasWorker = true;
  tile.workerNode = $('<div />').addClass('placed-worker');
  tile.workerNode.css({
    width: TILE_SIZE,
    height: TILE_SIZE,
    top: tile.domNode.position().top,
    left: tile.domNode.position().left
  });
  tile.workerNode.appendTo(container);
}

function applyWorkerEffects() {
  return new Promise((resolve, reject) => {
    function processWorker(tile, queue) {
      if (tile.type === 'woods') {
        sounds.cutWood.play();
        resources.wood++;
      } else {
        sounds.buildDam.play();
        resources.wood--;
        if (tile.type !== 'dam') {
          // NB: we allow repairing dams, and in this case the type is already set
          setTileType(tile, 'dam');
          // dams create stillwater to their right
          if (tile.j < ROW_COUNT) {
            const nextTile = map[tile.i][tile.j + 1]
            if (nextTile.type === 'water') {
              setTileType(nextTile, 'stillwater');
            }
          }
        }
        tile.strength = DAM_STRENGTH;
      }

      updateTileCounters();
      removeWorker(tile);
      updateResources();

      const duration = (tile.type === 'dam')? BUILD_DAM_ANIM_DURATION : CUT_WOOD_ANIM_DURATION;
      setTimeout(function() {
        if (queue.length > 0) {
          processWorker(queue.shift(), queue);
        } else {
          resolve();
        }
      }, duration);
    }

    const queue = [];
    for (const key in placedWorkers) {
      const coords = key.split('|');
      const tile = map[coords[0]][coords[1]];
      queue.push(tile);
    }

    if (queue.length === 0) {
      resolve();
      return;
    }

    processWorker(queue.shift(), queue);
  });
}

function endTurn() {
  console.log('ending turn...');

  endTurnButton.addClass('busy');
  applyWorkerEffects().then(function() {
    deferTransitions = true;
    updateMap();
    animatePendingTransitions();
    resources.time--;
    // TODO: win condition OR remove time resource, replace with objectives?

    updateTileCounters();
    updateResources();
    deferTransitions = false;
  });
}

function animatePendingTransitions() {
  let skippedGroups = 0;
  const stepDelay = FLOOD_ANIM_DURATION / 3;
  let timeUntilEnd = 0;
  for(const i in pendingTransitions) {
    const group = pendingTransitions[i];
    const waveDelay = (i-skippedGroups) * stepDelay;
    let groupHadDamCollapse = false;

    // keep track of empty groups so that they don't increase the delay
    if (group.length === 0) {
      skippedGroups++;
      continue;
    }

    for(const tile of group) {
      console.assert(tile.originalType, 'unmarked transformed tile', tile);
      // NB: tile object is already flooded, we need to extract the previous type
      let animType = 'flood-' + tile.originalType;
      if (tile.originalType === 'dam') {
        groupHadDamCollapse = true;
      }
      setTimeout(function(){
        tile.domNode.addClass(animType);
      }, waveDelay);
      timeUntilEnd = waveDelay + FLOOD_ANIM_DURATION
      setTimeout(function(){
        delete tile.originalType;
        tile.domNode.removeClass(tileTypes);
        tile.domNode.addClass(tile.type);
        tile.domNode.removeClass(animType);
      }, timeUntilEnd);
    }
    // this is the same delay as inside the loop, but we only want to play sounds once per group
    setTimeout(function(){
      const sfx = groupHadDamCollapse? sounds.destroyDam : sounds.floodTile;
      sfx.currentTime = 0;
      sfx.play();
    }, waveDelay);
  }
  setTimeout(function() {
    emptyPendingTransitionGroups();
    endTurnButton.removeClass('busy');
  }, timeUntilEnd);
}

function processTileClick(tile) {
  if (tile.hasWorker) {
    removeWorker(tile);
    sounds.removeWorker.play();
  } else {
    // refuse if not enough workers
    if (resources.workers === 0) {
      workerCounter.addClass('error');
      sounds.error.play();
      // TODO: global timeout var to debounce
      setTimeout(function() {
        workerCounter.removeClass('error');
      }, 600);
      return;
    }
    // refuse if not enough wood
    if (tile.type !== 'woods' && resources.wood === 0) {
      woodCounter.addClass('error');
      sounds.error.play();
      // TODO: global timeout var to debounce
      setTimeout(function() {
        woodCounter.removeClass('error');
      }, 600);
      return;
    }
    // refuse building on objective tiles
    if (tile.objectiveNode) {
      sounds.error.play();
      return;
    }
    // otherwise we're good
    placeWorker(tile);
    sounds.placeWorker.play();
  }

  updateResources();
}

function init() {
  // generate map of tiles from level layout
  for (let i=0; i<ROW_COUNT; i++) {
    const row = [];
    for (let j=0; j<COL_COUNT; j++) {
      const tileCode = levelData[currentLevel].map[i][j];
      const tile = {
        i: i,
        j: j,
        type: tileTypes[tileCode]
      };
      if (tile.type === 'dam') {
        tile.strength = DAM_STRENGTH;
      }
      row.push(tile);
    }
    map.push(row);
  }

  // generate DOM according to map
  for (let ri = 0; ri < map.length; ri++) {
    const row = map[ri];
    const rowDiv = $('<div />').addClass('row');
    for (let ci = 0; ci < row.length; ci++) {
      const cell = row[ci];
      console.assert(tileTypes.includes(cell.type));
      const cellDiv = $('<div />').addClass('tile').addClass(cell.type);
      cellDiv.css({
        width: TILE_SIZE,
        height: TILE_SIZE
      });
      cellDiv.on('click', () => {
        processTileClick(cell);
      });
      // we add a reference to the dom node
      cell.domNode = cellDiv;
      cellDiv.appendTo(rowDiv);
    }
    rowDiv.appendTo(container);
  }

  // generate objective markers
  console.log('Level objectives:');
  for (const objective of levelData[currentLevel].objectives) {
    console.log(objective);
    const objectiveTile = map[objective.y][objective.x];
    console.assert(objectiveTile.type !== 'water', 'Invalid objective');
    const objectiveNode = $('<div />').addClass('objective-marker');
    objectiveNode.css({
      width: TILE_SIZE,
      height: TILE_SIZE,
      top: objectiveTile.domNode.position().top,
      left: objectiveTile.domNode.position().left
    });
    objectiveNode.appendTo(container);
    objectiveTile.objectiveNode = objectiveNode;
  }

  // adjust layout according to the rendered map
  const blWidth = parseInt(endTurnButton.css('borderLeftWidth'), 10);
  const brWidth = parseInt(endTurnButton.css('borderRightWidth'), 10);
  const dB = blWidth + brWidth;
  endTurnButton.css({
    left: container.outerWidth(true) - endTurnButton.outerWidth(true) - dB
  });

  $('#icons-container').css({
    width: container.outerWidth(true) - 300
  });

  updateTileCounters();
  updateResources();
}

$(document).ready(function() {
  // init audio assets
  sounds.floodTile = new Audio('assets/flood_tile.mp3');
  sounds.buildDam = new Audio('assets/build_dam.mp3');
  sounds.destroyDam = new Audio('assets/destroy_dam.mp3');
  sounds.cutWood = new Audio('assets/cut_wood.mp3');
  sounds.placeWorker = new Audio('assets/place_worker.mp3');
  sounds.removeWorker = new Audio('assets/remove_worker.mp3');
  sounds.error = new Audio('assets/error.mp3');

  container = $('#map-container');
  endTurnButton = $('#end-turn-button');

  workerCounter = $('#icons-container .section.workers .counter');
  woodCounter = $('#icons-container .section.wood .counter');
  timerCounter = $('#icons-container .section.timer .counter');

  init();

  endTurnButton.on('click', () => {
    if (endTurnButton.hasClass('busy')) {
      return;
    }
    endTurn();
  });
});
