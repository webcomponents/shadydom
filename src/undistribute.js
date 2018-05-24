/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/
import {ensureShadyDataForNode} from './shady-data.js';
import {removeChild} from './native-methods.js';
import {accessors} from './native-tree.js';
import {UNDISTRIBUTED_ATTR} from './utils.js';

const {parentNode} = accessors;

// Add stylesheet for hiding undistributed nodes
const style = document.createElement('style');
style.textContent = `[${UNDISTRIBUTED_ATTR}] { display: none !important; }`;
document.head.appendChild(style);

// rather than remove elements that are logically not in the tree
// prefer hiding them when possible.
export function undistributeNode(node) {
  switch (node.nodeType) {
    case Node.TEXT_NODE: {
      const parent = parentNode(node);
      if (parent) {
        removeChild.call(parent, node);
      }
      break;
    }
    case Node.ELEMENT_NODE: {
      const data = ensureShadyDataForNode(node);
      data.undistributed = true;
      node.setAttribute(UNDISTRIBUTED_ATTR, '');
      break;
    }
  }
}

export function ensureNodeDistributable(node) {
  // ensure node is not marked as "undistributed" and therefore hidden
  const data = ensureShadyDataForNode(node);
  if (data.undistributed) {
    node.removeAttribute(UNDISTRIBUTED_ATTR);
    data.undistributed = false;
  }
}