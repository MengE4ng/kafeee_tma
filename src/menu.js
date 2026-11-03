// Prices are in the CURRENCY set in .env (USD by default).
// Edit freely — the server always recalculates totals from this file,
// so customers can't tamper with prices from the app.

const optionGroups = {
  size: {
    label: 'Size',
    default: 'R',
    choices: [
      { id: 'R', label: 'Regular', add: 0 },
      { id: 'L', label: 'Large', add: 0.5 },
    ],
  },
  sugar: {
    label: 'Sugar',
    default: '50',
    choices: [
      { id: '0', label: '0%', summary: 'No sugar' },
      { id: '25', label: '25%', summary: 'Sugar 25%' },
      { id: '50', label: '50%', summary: 'Sugar 50%' },
      { id: '75', label: '75%', summary: 'Sugar 75%' },
      { id: '100', label: '100%', summary: 'Sugar 100%' },
    ],
  },
  ice: {
    label: 'Ice',
    default: 'normal',
    choices: [
      { id: 'none', label: 'No ice' },
      { id: 'less', label: 'Less ice' },
      { id: 'normal', label: 'Normal ice' },
    ],
  },
  temp: {
    label: 'Temperature',
    default: 'iced',
    choices: [
      { id: 'iced', label: 'Iced' },
      { id: 'hot', label: 'Hot' },
    ],
  },
};

// All drinks are 20oz, so there is no size option.
const items = [
  { id: 'cafe-latte', name: 'Cafe Latte', category: 'Coffee', price: 1.0, emoji: '☕', desc: 'Espresso and creamy milk', options: ['temp', 'sugar', 'ice'] },
  { id: 'ice-kafe', name: 'Ice Kafe', category: 'Coffee', price: 1.25, emoji: '🧊', desc: 'Our strong iced coffee', options: ['sugar', 'ice'] },
  { id: 'americano', name: 'Americano', category: 'Coffee', price: 0.75, emoji: '☕', desc: 'Espresso and water, nothing else', options: ['temp', 'sugar', 'ice'] },
  { id: 'matcha-latte', name: 'Matcha Latte', category: 'Matcha', price: 1.25, emoji: '🍵', desc: 'Green tea matcha with milk', options: ['sugar', 'ice'] },
  { id: 'matcha-oreo', name: 'Matcha Oreo', category: 'Matcha', price: 1.5, emoji: '🍪', desc: 'Matcha latte with crushed Oreo', options: ['sugar', 'ice'] },
  { id: 'matcha-strawberry', name: 'Matcha Strawberry', category: 'Matcha', price: 1.5, emoji: '🍓', desc: 'Matcha over strawberry milk', options: ['sugar', 'ice'] },
];

const categories = [...new Set(items.map((i) => i.category))];

module.exports = { items, categories, optionGroups };
