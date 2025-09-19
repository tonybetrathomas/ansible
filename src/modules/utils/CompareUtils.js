import deepDiff from 'deep-diff';
import { getAsyncContextLogger } from '../../utils/logger.js';

const ignoreList ={'TD' : ['registeredAt']};


export async function compareObjects(object1, object2, type) {
    const logger = getAsyncContextLogger();
    const differences = deepDiff(object1, object2);
    logger.info(`Diff :${JSON.stringify(differences)}`);
    const paths = [];
    differences.forEach(diff => {
        if (diff.path) {
            paths.push(diff.path.join('.'));
        }
    });

    const set = new Set(ignoreList[type]);
    const result = paths.filter(item => !set.has(item))
    return result;
}


export async function deepMerge(source, destination) {
    const output = { ...destination };
    
    if (isObject(source) && isObject(destination)) {
      Object.keys(source).forEach(key => {
        if (isObject(source[key]) && isObject(destination[key])) {
          // If both values are objects, merge them recursively
          output[key] = deepMerge(source[key], destination[key]);
        } else {
          // Otherwise, source value overwrites destination value
          output[key] = source[key];
        }
      });
    }
    
    return output;
  }