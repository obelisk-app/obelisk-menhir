// Emoji picker — standard Unicode emoji only.
//
// No custom emoji, deliberately: a custom set means images, images mean a host
// to fetch them from, and fetching per-message images over a Tor circuit is
// exactly the kind of chatty, identifying traffic Menhir is built to avoid.
// Unicode emoji are text — they travel inside the message, cost nothing extra,
// and render with the platform's own font.
//
// The dataset is a hand-kept subset (a few hundred of the ones people actually
// use) rather than the full Unicode list, so the bundle stays small enough to
// ship to a phone. Keywords are space-separated to keep the source compact.

const CATEGORIES = [
  {
    id: 'faces',
    label: 'Smileys',
    icon: '🙂',
    emoji: [
      ['😀', 'grin smile happy'], ['😃', 'smile happy joy'], ['😄', 'smile laugh happy'],
      ['😁', 'beam grin teeth'], ['😆', 'laugh haha xd'], ['😅', 'sweat laugh relief'],
      ['🤣', 'rofl rolling laugh'], ['😂', 'joy tears laugh lol'], ['🙂', 'slight smile'],
      ['🙃', 'upside down silly'], ['😉', 'wink'], ['😊', 'blush smile happy'],
      ['😇', 'halo angel innocent'], ['🥰', 'love hearts adore'], ['😍', 'heart eyes love'],
      ['🤩', 'star struck wow'], ['😘', 'kiss love'], ['😗', 'kissing'],
      ['😋', 'yum tasty tongue'], ['😛', 'tongue'], ['😜', 'wink tongue silly'],
      ['🤪', 'zany crazy silly'], ['🤗', 'hug'], ['🤭', 'oops giggle'],
      ['🤫', 'shh quiet secret'], ['🤔', 'thinking hmm'], ['🤨', 'eyebrow suspicious doubt'],
      ['😐', 'neutral meh'], ['😑', 'expressionless'], ['😶', 'silent no mouth'],
      ['😏', 'smirk'], ['😒', 'unamused meh'], ['🙄', 'eye roll'],
      ['😬', 'grimace awkward'], ['😮', 'surprised open mouth'], ['😯', 'hushed'],
      ['😴', 'sleep zzz tired'], ['😪', 'sleepy'], ['😌', 'relieved calm'],
      ['😔', 'pensive sad'], ['😕', 'confused'], ['🙁', 'frown slight sad'],
      ['😞', 'disappointed'], ['😢', 'cry sad tear'], ['😭', 'sob crying loud'],
      ['😤', 'triumph steam angry'], ['😠', 'angry mad'], ['😡', 'rage furious'],
      ['🤬', 'cursing swearing'], ['😳', 'flushed embarrassed'], ['🥵', 'hot heat'],
      ['🥶', 'cold freezing'], ['😱', 'scream fear shock'], ['😨', 'fearful'],
      ['😰', 'anxious sweat'], ['🤯', 'mind blown explode'], ['😷', 'mask sick'],
      ['🤒', 'sick fever'], ['🤢', 'nauseated sick'], ['🤮', 'vomit sick'],
      ['🥳', 'party celebrate'], ['😎', 'cool sunglasses'], ['🤓', 'nerd glasses'],
      ['🧐', 'monocle inspect'], ['😈', 'devil mischief'], ['💀', 'skull dead'],
      ['👻', 'ghost'], ['👽', 'alien'], ['🤖', 'robot bot'],
      ['💩', 'poop'], ['🥲', 'tear smile'], ['🫠', 'melting'],
    ],
  },
  {
    id: 'people',
    label: 'People',
    icon: '👍',
    emoji: [
      ['👍', 'thumbs up yes ok like'], ['👎', 'thumbs down no dislike'], ['👌', 'ok perfect'],
      ['✌️', 'peace victory'], ['🤞', 'fingers crossed luck'], ['🤙', 'call me shaka'],
      ['🤝', 'handshake deal agree'], ['👏', 'clap applause'], ['🙌', 'raised hands praise'],
      ['🙏', 'pray thanks please'], ['💪', 'muscle strong'], ['✍️', 'writing'],
      ['👋', 'wave hello bye'], ['🫡', 'salute'], ['🖖', 'spock'],
      ['👀', 'eyes look'], ['🧠', 'brain'], ['🫀', 'heart organ'],
      ['👤', 'person user'], ['👥', 'people users group'], ['🧑', 'person'],
      ['👨', 'man'], ['👩', 'woman'], ['🧒', 'child'],
      ['👴', 'old man'], ['👵', 'old woman'], ['🕵️', 'detective spy'],
      ['👮', 'police'], ['🧑‍💻', 'developer coder programmer'], ['🧑‍🚀', 'astronaut space'],
      ['🥷', 'ninja'], ['🦸', 'hero'], ['🧙', 'wizard mage'],
      ['💃', 'dancer dance'], ['🕺', 'dancing man'], ['🤷', 'shrug dunno'],
      ['🤦', 'facepalm'], ['🙋', 'raising hand'], ['🙇', 'bow sorry'],
    ],
  },
  {
    id: 'nature',
    label: 'Nature',
    icon: '🌿',
    emoji: [
      ['🐶', 'dog puppy'], ['🐱', 'cat kitten'], ['🐭', 'mouse'],
      ['🐹', 'hamster'], ['🐰', 'rabbit bunny'], ['🦊', 'fox'],
      ['🐻', 'bear'], ['🐼', 'panda'], ['🐨', 'koala'],
      ['🐯', 'tiger'], ['🦁', 'lion'], ['🐮', 'cow'],
      ['🐷', 'pig'], ['🐸', 'frog'], ['🐵', 'monkey'],
      ['🐔', 'chicken'], ['🐧', 'penguin'], ['🐦', 'bird'],
      ['🦅', 'eagle'], ['🦉', 'owl'], ['🦇', 'bat'],
      ['🐺', 'wolf'], ['🐗', 'boar'], ['🐴', 'horse'],
      ['🦄', 'unicorn'], ['🐝', 'bee'], ['🐛', 'bug caterpillar'],
      ['🦋', 'butterfly'], ['🐌', 'snail slow'], ['🐢', 'turtle'],
      ['🐍', 'snake'], ['🐙', 'octopus'], ['🦑', 'squid'],
      ['🦀', 'crab'], ['🐟', 'fish'], ['🐬', 'dolphin'],
      ['🐳', 'whale'], ['🦈', 'shark'], ['🌵', 'cactus'],
      ['🌲', 'tree evergreen'], ['🌳', 'tree'], ['🌴', 'palm tree'],
      ['🌱', 'seedling sprout'], ['🌿', 'herb leaf'], ['☘️', 'clover'],
      ['🍀', 'four leaf clover luck'], ['🍁', 'maple leaf'], ['🍂', 'fallen leaves autumn'],
      ['🌺', 'flower hibiscus'], ['🌻', 'sunflower'], ['🌹', 'rose'],
      ['🌷', 'tulip'], ['🌸', 'blossom sakura'], ['🌼', 'daisy'],
      ['🌞', 'sun'], ['🌝', 'full moon face'], ['🌚', 'new moon face'],
      ['🌙', 'crescent moon night'], ['⭐', 'star'], ['🌟', 'glowing star'],
      ['✨', 'sparkles shine'], ['⚡', 'lightning zap'], ['🔥', 'fire lit'],
      ['💧', 'droplet water'], ['🌊', 'wave ocean'], ['❄️', 'snowflake cold'],
      ['☀️', 'sunny clear'], ['⛅', 'partly cloudy'], ['☁️', 'cloud'],
      ['🌧️', 'rain'], ['⛈️', 'storm thunder'], ['🌈', 'rainbow'],
    ],
  },
  {
    id: 'food',
    label: 'Food',
    icon: '🍕',
    emoji: [
      ['🍏', 'apple green'], ['🍎', 'apple red'], ['🍐', 'pear'],
      ['🍊', 'orange tangerine'], ['🍋', 'lemon'], ['🍌', 'banana'],
      ['🍉', 'watermelon'], ['🍇', 'grapes'], ['🍓', 'strawberry'],
      ['🫐', 'blueberries'], ['🍒', 'cherries'], ['🍑', 'peach'],
      ['🥭', 'mango'], ['🍍', 'pineapple'], ['🥥', 'coconut'],
      ['🥑', 'avocado'], ['🍅', 'tomato'], ['🥕', 'carrot'],
      ['🌽', 'corn'], ['🌶️', 'chili hot pepper'], ['🥔', 'potato'],
      ['🍞', 'bread'], ['🥐', 'croissant'], ['🥖', 'baguette'],
      ['🧀', 'cheese'], ['🥚', 'egg'], ['🍳', 'cooking fried egg'],
      ['🥞', 'pancakes'], ['🥓', 'bacon'], ['🍔', 'burger'],
      ['🍟', 'fries'], ['🍕', 'pizza'], ['🌭', 'hot dog'],
      ['🌮', 'taco'], ['🌯', 'burrito'], ['🥙', 'wrap'],
      ['🥗', 'salad'], ['🍝', 'pasta spaghetti'], ['🍜', 'ramen noodles'],
      ['🍣', 'sushi'], ['🍤', 'shrimp'], ['🍚', 'rice'],
      ['🍦', 'ice cream'], ['🍩', 'donut'], ['🍪', 'cookie'],
      ['🎂', 'birthday cake'], ['🍰', 'cake slice'], ['🍫', 'chocolate'],
      ['🍿', 'popcorn'], ['🧂', 'salt'], ['☕', 'coffee'],
      ['🍵', 'tea'], ['🧉', 'mate'], ['🍺', 'beer'],
      ['🍻', 'cheers beers'], ['🥂', 'champagne toast'], ['🍷', 'wine'],
      ['🥃', 'whisky'], ['🍸', 'cocktail'], ['🧊', 'ice'],
    ],
  },
  {
    id: 'activity',
    label: 'Activity',
    icon: '⚽',
    emoji: [
      ['⚽', 'soccer football'], ['🏀', 'basketball'], ['🏈', 'american football'],
      ['⚾', 'baseball'], ['🎾', 'tennis'], ['🏐', 'volleyball'],
      ['🏉', 'rugby'], ['🎱', 'pool billiards'], ['🏓', 'ping pong'],
      ['🏸', 'badminton'], ['🥅', 'goal'], ['⛳', 'golf'],
      ['🏹', 'bow archery'], ['🎣', 'fishing'], ['🥊', 'boxing'],
      ['🥋', 'martial arts'], ['⛸️', 'ice skate'], ['🎿', 'ski'],
      ['🛹', 'skateboard'], ['🚴', 'cycling bike'], ['🏃', 'running run'],
      ['🧗', 'climbing'], ['🏊', 'swimming'], ['🏆', 'trophy win'],
      ['🥇', 'gold medal first'], ['🥈', 'silver medal'], ['🥉', 'bronze medal'],
      ['🎯', 'target bullseye'], ['🎮', 'video game controller'], ['🕹️', 'joystick'],
      ['🎲', 'dice'], ['♟️', 'chess pawn'], ['🎸', 'guitar'],
      ['🎹', 'piano keyboard'], ['🥁', 'drum'], ['🎤', 'microphone sing'],
      ['🎧', 'headphones'], ['🎬', 'clapper film'], ['🎨', 'art paint'],
      ['🎭', 'theater masks'], ['🎪', 'circus'], ['🎉', 'party popper tada'],
      ['🎊', 'confetti'], ['🎈', 'balloon'], ['🎁', 'gift present'],
    ],
  },
  {
    id: 'travel',
    label: 'Travel',
    icon: '🚀',
    emoji: [
      ['🚗', 'car'], ['🚕', 'taxi'], ['🚙', 'suv'],
      ['🚌', 'bus'], ['🚑', 'ambulance'], ['🚓', 'police car'],
      ['🚚', 'truck'], ['🚜', 'tractor'], ['🏍️', 'motorcycle'],
      ['🚲', 'bicycle bike'], ['🛵', 'scooter'], ['✈️', 'airplane flight'],
      ['🚀', 'rocket launch'], ['🛸', 'ufo'], ['🚁', 'helicopter'],
      ['⛵', 'sailboat'], ['🚢', 'ship'], ['🚂', 'train'],
      ['🚇', 'metro subway'], ['🗺️', 'map'], ['🧭', 'compass'],
      ['🏔️', 'mountain'], ['🌋', 'volcano'], ['🏝️', 'island'],
      ['🏖️', 'beach'], ['🏕️', 'camping tent'], ['🏠', 'house home'],
      ['🏢', 'office building'], ['🏰', 'castle'], ['🗽', 'statue liberty'],
      ['🗼', 'tower'], ['🌆', 'city dusk'], ['🌃', 'night city'],
      ['🌍', 'earth globe'], ['🌎', 'americas globe'], ['🧱', 'brick'],
      ['⛺', 'tent'], ['🚦', 'traffic light'], ['🛑', 'stop sign'],
    ],
  },
  {
    id: 'objects',
    label: 'Objects',
    icon: '💻',
    emoji: [
      ['💻', 'laptop computer'], ['🖥️', 'desktop computer'], ['⌨️', 'keyboard'],
      ['🖱️', 'mouse'], ['🖨️', 'printer'], ['📱', 'phone mobile'],
      ['☎️', 'telephone'], ['📷', 'camera'], ['🎥', 'movie camera'],
      ['📺', 'tv'], ['📻', 'radio'], ['🔋', 'battery'],
      ['🔌', 'plug power'], ['💾', 'floppy save'], ['💿', 'disc'],
      ['🗜️', 'clamp compress'], ['🔍', 'search magnifying'], ['🔎', 'zoom search'],
      ['💡', 'idea light bulb'], ['🔦', 'flashlight torch'], ['🕯️', 'candle'],
      ['📖', 'book open read'], ['📚', 'books'], ['📝', 'memo note write'],
      ['✏️', 'pencil'], ['📌', 'pin'], ['📎', 'paperclip'],
      ['📁', 'folder'], ['📂', 'open folder'], ['🗂️', 'dividers'],
      ['📅', 'calendar date'], ['⏰', 'alarm clock'], ['⏳', 'hourglass wait'],
      ['🔒', 'lock private'], ['🔓', 'unlock open'], ['🔑', 'key'],
      ['🗝️', 'old key'], ['🔨', 'hammer'], ['🛠️', 'tools'],
      ['🔧', 'wrench fix'], ['🔩', 'nut bolt'], ['⚙️', 'gear settings'],
      ['🧰', 'toolbox'], ['🧲', 'magnet'], ['🔗', 'link chain'],
      ['📡', 'satellite antenna signal'], ['🛰️', 'satellite'], ['💰', 'money bag'],
      ['💸', 'money flying'], ['💳', 'card'], ['🧾', 'receipt'],
      ['📦', 'package box'], ['📬', 'mailbox'], ['✉️', 'envelope mail'],
      ['🗑️', 'trash delete'], ['🧹', 'broom clean'], ['🪙', 'coin'],
    ],
  },
  {
    id: 'symbols',
    label: 'Symbols',
    icon: '❤️',
    emoji: [
      ['❤️', 'red heart love'], ['🧡', 'orange heart'], ['💛', 'yellow heart'],
      ['💚', 'green heart'], ['💙', 'blue heart'], ['💜', 'purple heart'],
      ['🖤', 'black heart'], ['🤍', 'white heart'], ['💔', 'broken heart'],
      ['💕', 'two hearts'], ['💞', 'revolving hearts'], ['💯', 'hundred perfect'],
      ['✅', 'check done yes'], ['☑️', 'checkbox'], ['✔️', 'check mark'],
      ['❌', 'cross no wrong'], ['⭕', 'circle'], ['❗', 'exclamation'],
      ['❓', 'question'], ['⚠️', 'warning caution'], ['🚫', 'forbidden no'],
      ['♻️', 'recycle'], ['🔔', 'bell notification'], ['🔕', 'mute bell'],
      ['🔊', 'loud sound'], ['🔇', 'muted'], ['📢', 'announce loudspeaker'],
      ['💬', 'speech bubble chat'], ['💭', 'thought bubble'], ['🗯️', 'anger bubble'],
      ['♾️', 'infinity'], ['➕', 'plus add'], ['➖', 'minus'],
      ['✖️', 'multiply'], ['➗', 'divide'], ['🔀', 'shuffle'],
      ['🔁', 'repeat loop'], ['▶️', 'play'], ['⏸️', 'pause'],
      ['⏹️', 'stop'], ['⏺️', 'record'], ['⏭️', 'next skip'],
      ['🔺', 'red triangle up'], ['🔻', 'red triangle down'], ['🟢', 'green circle online'],
      ['🔴', 'red circle offline'], ['🟡', 'yellow circle'], ['⚫', 'black circle'],
      ['⬛', 'black square'], ['⬜', 'white square'], ['🔶', 'orange diamond'],
      ['💠', 'diamond'], ['🆗', 'ok button'], ['🆕', 'new'],
      ['🔝', 'top'], ['🔜', 'soon'], ['#️⃣', 'hash channel'],
    ],
  },
];

const RECENTS_KEY = 'menhir-recent-emoji';
const MAX_RECENTS = 24;

function loadRecents() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((c) => typeof c === 'string').slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

function rememberRecent(char) {
  const list = [char, ...loadRecents().filter((c) => c !== char)].slice(0, MAX_RECENTS);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list)); } catch {}
  return list;
}

/** Every emoji, flattened, for search. */
const ALL = CATEGORIES.flatMap((c) => c.emoji);

function search(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = [];
  const contains = [];
  for (const [char, keywords] of ALL) {
    const words = keywords.split(' ');
    if (words.some((w) => w === q || w.startsWith(q))) starts.push(char);
    else if (keywords.includes(q)) contains.push(char);
  }
  return [...starts, ...contains].slice(0, 60);
}

/**
 * Build the picker once and return a handle.
 *
 * The panel lives next to the composer rather than in a modal: picking three
 * emoji in a row should not mean opening and closing a dialog three times, so
 * it stays open until you click away or press Escape.
 */
export function createEmojiPicker({ onPick }) {
  const root = document.createElement('div');
  root.className = 'emoji-picker hidden';
  root.innerHTML = `
    <div class="emoji-search-row">
      <input class="emoji-search" type="text" placeholder="Search emoji" aria-label="Search emoji" />
    </div>
    <div class="emoji-tabs" role="tablist"></div>
    <div class="emoji-grid" role="listbox"></div>
  `;
  const searchInput = root.querySelector('.emoji-search');
  const tabs = root.querySelector('.emoji-tabs');
  const grid = root.querySelector('.emoji-grid');

  // Opening onto an empty "Recent" tab the first time is a picker that looks
  // broken — start on the first category until there is a history to show.
  let activeTab = loadRecents().length ? 'recent' : CATEGORIES[0].id;

  const paintTabs = () => {
    tabs.innerHTML = '';
    const entries = [{ id: 'recent', label: 'Recent', icon: '🕘' }, ...CATEGORIES];
    for (const c of entries) {
      const b = document.createElement('button');
      b.className = 'emoji-tab' + (c.id === activeTab ? ' active' : '');
      b.textContent = c.icon;
      b.title = c.label;
      b.onclick = () => { activeTab = c.id; searchInput.value = ''; paintTabs(); paintGrid(); };
      tabs.appendChild(b);
    }
  };

  const cell = (char) => {
    const b = document.createElement('button');
    b.className = 'emoji-cell';
    b.textContent = char;
    b.onclick = () => {
      rememberRecent(char);
      onPick(char);
      if (activeTab === 'recent') paintGrid();
    };
    return b;
  };

  const paintGrid = () => {
    grid.innerHTML = '';
    const query = searchInput.value;
    if (query.trim()) {
      const hits = search(query);
      if (!hits.length) {
        const p = document.createElement('p');
        p.className = 'muted small emoji-empty';
        p.textContent = 'Nothing matches that.';
        grid.appendChild(p);
        return;
      }
      for (const char of hits) grid.appendChild(cell(char));
      return;
    }
    if (activeTab === 'recent') {
      const recents = loadRecents();
      if (!recents.length) {
        const p = document.createElement('p');
        p.className = 'muted small emoji-empty';
        p.textContent = 'Emoji you use show up here.';
        grid.appendChild(p);
        return;
      }
      for (const char of recents) grid.appendChild(cell(char));
      return;
    }
    const cat = CATEGORIES.find((c) => c.id === activeTab);
    for (const [char] of cat?.emoji || []) grid.appendChild(cell(char));
  };

  searchInput.addEventListener('input', paintGrid);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = grid.querySelector('.emoji-cell');
    first?.click();
  });

  paintTabs();
  paintGrid();

  return {
    element: root,
    isOpen: () => !root.classList.contains('hidden'),
    open() {
      root.classList.remove('hidden');
      if (activeTab === 'recent' && !loadRecents().length) {
        activeTab = CATEGORIES[0].id;
        paintTabs();
      }
      paintGrid();
      // A phone would cover the picker with its keyboard.
      if (!window.matchMedia?.('(pointer: coarse)').matches) searchInput.focus();
    },
    close() {
      root.classList.add('hidden');
      searchInput.value = '';
    },
    toggle() { this.isOpen() ? this.close() : this.open(); },
  };
}
