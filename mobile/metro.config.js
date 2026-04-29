const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const exclusionList = require('metro-config/src/defaults/exclusionList');

const projectRoot = __dirname;
const rootNodeModules = path.resolve(projectRoot, '..', 'node_modules');

function escapePath(filePath) {
  return filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const config = getDefaultConfig(projectRoot);

config.watchFolders = [];
config.resolver.blockList = exclusionList([
  new RegExp(`${escapePath(rootNodeModules)}\\/.*`),
]);

module.exports = config;
