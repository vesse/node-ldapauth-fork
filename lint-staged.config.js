module.exports = {
  '*': ['prettier --ignore-unknown --write'],
  '*.{js,jsx,json,ts,tsx}': ['eslint --quiet', 'prettier --write'],
};
