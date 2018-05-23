/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/
import {accessors} from './native-tree.js';
import {getInnerHTML} from './innerHTML.js';
import {shadyDataForNode} from './shady-data.js';

function notUnDistributed(node) {
  const d = shadyDataForNode(node);
  return !d || !d.undistributed;
}

export function getComposedHTML(node) {
  return getInnerHTML(node, (n) =>
      accessors.childNodes(n).filter(notUnDistributed));
}

export function getComposedChildNodes(node) {
  return accessors.childNodes(node).filter(notUnDistributed);
}

export function getComposedTextContent(node) {
  return node.nodeType === Node.ELEMENT_NODE ? accessors.childNodes(node)
      .filter(notUnDistributed)
      .map(n => getComposedTextContent(n)).join('') : node.textContent;
}
