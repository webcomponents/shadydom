/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

'use strict';

import * as utils from './utils'
import {getInnerHTML} from './innerHTML'
import {tree} from './tree'

let mixinImpl = {

  // Try to add node. Record logical info, track insertion points, perform
  // distribution iff needed. Return true if the add is handled.
  addNode(container, node, ref_node) {
    let ownerRoot = this.ownerShadyRootForNode(container);
    if (ownerRoot) {
      // optimization: special insertion point tracking
      if (node.__noInsertionPoint) {
        ownerRoot._skipUpdateInsertionPoints = true;
      }
      // note: we always need to see if an insertion point is added
      // since this saves logical tree info; however, invalidation state
      // needs
      let ipAdded = this._maybeAddInsertionPoint(node, container, ownerRoot);
      // invalidate insertion points IFF not already invalid!
      if (ipAdded) {
        ownerRoot._skipUpdateInsertionPoints = false;
      }
      this._addedNode(node, ownerRoot);
    }
    if (tree.Logical.hasChildNodes(container)) {
      tree.Logical.recordInsertBefore(node, container, ref_node);
    }
    // if not distributing and not adding to host, do a fast path addition
    let handled = this._maybeDistribute(node, container, ownerRoot) ||
      container.shadyRoot;
    return handled;
  },

  // Try to remove node: update logical info and perform distribution iff
  // needed. Return true if the removal has been handled.
  // note that it's possible for both the node's host and its parent
  // to require distribution... both cases are handled here.
  removeNode(node) {
    // important that we want to do this only if the node has a logical parent
    let logicalParent = tree.Logical.hasParentNode(node) &&
      tree.Logical.getParentNode(node);
    let distributed;
    let ownerRoot = this.ownerShadyRootForNode(node);
    if (logicalParent) {
      // distribute node's parent iff needed
      distributed = this.maybeDistributeParent(node);
      tree.Logical.recordRemoveChild(node, logicalParent);
      // remove node from root and distribute it iff needed
      if (ownerRoot && (this._removeDistributedChildren(ownerRoot, node) ||
        logicalParent.localName === ownerRoot.getInsertionPointTag())) {
        ownerRoot._skipUpdateInsertionPoints = false;
        ownerRoot.update();
      }
    }
    this._removeOwnerShadyRoot(node);
    if (ownerRoot) {
      this._removedNode(node, ownerRoot);
    }
    return distributed;
  },


  _scheduleObserver(node, addedNode, removedNode) {
    let observer = node.__dom && node.__dom.observer;
    if (observer) {
      if (addedNode) {
        observer.addedNodes.push(addedNode);
      }
      if (removedNode) {
        observer.removedNodes.push(removedNode);
      }
      observer.schedule();
    }
  },

  removeNodeFromParent(node, parent) {
    if (parent) {
      this._scheduleObserver(parent, null, node);
      this.removeNode(node);
    } else {
      this._removeOwnerShadyRoot(node);
    }
  },

  _hasCachedOwnerRoot(node) {
    return Boolean(node.__ownerShadyRoot !== undefined);
  },

  getRootNode(node) {
    if (!node || !node.nodeType) {
      return;
    }
    let root = node.__ownerShadyRoot;
    if (root === undefined) {
      if (utils.isShadyRoot(node)) {
        root = node;
      } else {
        let parent = tree.Logical.getParentNode(node);
        root = parent ? this.getRootNode(parent) : node;
      }
      // memo-ize result for performance but only memo-ize
      // result if node is in the document. This avoids a problem where a root
      // can be cached while an element is inside a fragment.
      // If this happens and we cache the result, the value can become stale
      // because for perf we avoid processing the subtree of added fragments.
      if (document.documentElement.contains(node)) {
        node.__ownerShadyRoot = root;
      }
    }
    return root;
  },

  ownerShadyRootForNode(node) {
    let root = this.getRootNode(node);
    if (utils.isShadyRoot(root)) {
      return root;
    }
  },

  _maybeDistribute(node, container, ownerRoot) {
    // TODO(sorvell): technically we should check non-fragment nodes for
    // <content> children but since this case is assumed to be exceedingly
    // rare, we avoid the cost and will address with some specific api
    // when the need arises.  For now, the user must call
    // distributeContent(true), which updates insertion points manually
    // and forces distribution.
    let insertionPointTag = ownerRoot && ownerRoot.getInsertionPointTag() || '';
    let fragContent = (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) &&
      !node.__noInsertionPoint &&
      insertionPointTag && node.querySelector(insertionPointTag);
    let wrappedContent = fragContent &&
      (tree.Logical.getParentNode(fragContent).nodeType !==
      Node.DOCUMENT_FRAGMENT_NODE);
    let hasContent = fragContent || (node.localName === insertionPointTag);
    // There are 3 possible cases where a distribution may need to occur:
    // 1. <content> being inserted (the host of the shady root where
    //    content is inserted needs distribution)
    // 2. children being inserted into parent with a shady root (parent
    //    needs distribution)
    // 3. container is an insertionPoint
    if (hasContent || (container.localName === insertionPointTag)) {
      if (ownerRoot) {
        // note, insertion point list update is handled after node
        // mutations are complete
        ownerRoot.update();
      }
    }
    let needsDist = this._nodeNeedsDistribution(container);
    if (needsDist) {
      container.shadyRoot.update();
    }
    // Return true when distribution will fully handle the composition
    // Note that if a content was being inserted that was wrapped by a node,
    // and the parent does not need distribution, return false to allow
    // the nodes to be added directly, after which children may be
    // distributed and composed into the wrapping node(s)
    return needsDist || (hasContent && !wrappedContent);
  },

  /* note: parent argument is required since node may have an out
  of date parent at this point; returns true if a <content> is being added */
  _maybeAddInsertionPoint(node, parent, root) {
    let added;
    let insertionPointTag = root.getInsertionPointTag();
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE &&
      !node.__noInsertionPoint) {
      let c$ = node.querySelectorAll(insertionPointTag);
      for (let i=0, n, np, na; (i<c$.length) && (n=c$[i]); i++) {
        np = tree.Logical.getParentNode(n);
        // don't allow node's parent to be fragment itself
        if (np === node) {
          np = parent;
        }
        na = this._maybeAddInsertionPoint(n, np, root);
        added = added || na;
      }
    } else if (node.localName === insertionPointTag) {
      tree.Logical.saveChildNodes(parent);
      tree.Logical.saveChildNodes(node);
      added = true;
    }
    return added;
  },

  _nodeNeedsDistribution(node) {
    return node && node.shadyRoot &&
      node.shadyRoot.hasInsertionPoint();
  },

  // TODO(sorvell): needed for style scoping, use MO?
  _addedNode() {},
  _removedNode() {},
  /*
  _addedNode(node, root) {
    // if (ShadyDOM.addedNode) {
    //   ShadyDOM.addedNode(node, root);
    // }
  },

  _removedNode(node, root) {
    if (ShadyDOM.removedNode) {
      ShadyDOM.removedNode(node, root);
    }
  },
  */

  _removeDistributedChildren(root, container) {
    let hostNeedsDist;
    let ip$ = root._insertionPoints;
    for (let i=0; i<ip$.length; i++) {
      let insertionPoint = ip$[i];
      if (this._contains(container, insertionPoint)) {
        let dc$ = insertionPoint.assignedNodes({flatten: true});
        for (let j=0; j<dc$.length; j++) {
          hostNeedsDist = true;
          let node = dc$[j];
          let parent = tree.Composed.getParentNode(node);
          if (parent) {
            tree.Composed.removeChild(parent, node);
          }
        }
      }
    }
    return hostNeedsDist;
  },

  _contains(container, node) {
    while (node) {
      if (node == container) {
        return true;
      }
      node = tree.Logical.getParentNode(node);
    }
  },

  _removeOwnerShadyRoot(node) {
    // optimization: only reset the tree if node is actually in a root
    if (this._hasCachedOwnerRoot(node)) {
      let c$ = tree.Logical.getChildNodes(node);
      for (let i=0, l=c$.length, n; (i<l) && (n=c$[i]); i++) {
        this._removeOwnerShadyRoot(n);
      }
    }
    node.__ownerShadyRoot = undefined;
  },

  // TODO(sorvell): This will fail if distribution that affects this
  // question is pending; this is expected to be exceedingly rare, but if
  // the issue comes up, we can force a flush in this case.
  firstComposedNode(insertionPoint) {
    let n$ = insertionPoint.assignedNodes({flatten: true});
    let root = this.getRootNode(insertionPoint);
    for (let i=0, l=n$.length, n; (i<l) && (n=n$[i]); i++) {
      // means that we're composed to this spot.
      if (root.isFinalDestination(insertionPoint, n)) {
        return n;
      }
    }
  },

  clearNode(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  },

  maybeDistributeParent(node) {
    let parent = tree.Logical.getParentNode(node);
    if (this._nodeNeedsDistribution(parent)) {
      parent.shadyRoot.update();
      return true;
    }
  },

  maybeDistributeAttributeChange(node, name) {
    let distribute = (node.localName === 'slot' && name === 'name');
    if (distribute) {
      let root = this.getRootNode(node);
      if (root.update) {
        root.update();
      }
    }
  },

  // NOTE: `query` is used primarily for ShadyDOM's querySelector impl,
  // but it's also generally useful to recurse through the element tree
  // and is used by Polymer's styling system.
  query(node, matcher, halter) {
    let list = [];
    this._queryElements(tree.Logical.getChildNodes(node), matcher,
      halter, list);
    return list;
  },

  _queryElements(elements, matcher, halter, list) {
    for (let i=0, l=elements.length, c; (i<l) && (c=elements[i]); i++) {
      if (c.nodeType === Node.ELEMENT_NODE &&
          this._queryElement(c, matcher, halter, list)) {
        return true;
      }
    }
  },

  _queryElement(node, matcher, halter, list) {
    let result = matcher(node);
    if (result) {
      list.push(node);
    }
    if (halter && halter(result)) {
      return result;
    }
    this._queryElements(tree.Logical.getChildNodes(node), matcher,
      halter, list);
  },

  activeElementForNode(node) {
    let active = document.activeElement;
    if (!active) {
      return null;
    }
    let isShadyRoot = !!(utils.isShadyRoot(node));
    if (node !== document) {
      // If this node isn't a document or shady root, then it doesn't have
      // an active element.
      if (!isShadyRoot) {
        return null;
      }
      // If this shady root's host is the active element or the active
      // element is not a descendant of the host (in the composed tree),
      // then it doesn't have an active element.
      if (node.host === active ||
          !node.host.contains(active)) {
        return null;
      }
    }
    // This node is either the document or a shady root of which the active
    // element is a (composed) descendant of its host; iterate upwards to
    // find the active element's most shallow host within it.
    let activeRoot = this.ownerShadyRootForNode(active);
    while (activeRoot && activeRoot !== node) {
      active = activeRoot.host;
      activeRoot = this.ownerShadyRootForNode(active);
    }
    if (node === document) {
      // This node is the document, so activeRoot should be null.
      return activeRoot ? null : active;
    } else {
      // This node is a non-document shady root, and it should be
      // activeRoot.
      return activeRoot === node ? active : null;
    }
  }

};

let nativeCloneNode = Element.prototype.cloneNode;
let nativeImportNode = Document.prototype.importNode;
let nativeSetAttribute = Element.prototype.setAttribute;
let nativeRemoveAttribute = Element.prototype.removeAttribute;

let NodeMixin = {};

Object.defineProperties(NodeMixin, {

  parentElement: {
    get() {
      return tree.Logical.getParentNode(this);
    },
    configurable: true
  },

  parentNode: {
    get() {
      return tree.Logical.getParentNode(this);
    },
    configurable: true
  },

  nextSibling: {
    get() {
      return tree.Logical.getNextSibling(this);
    },
    configurable: true
  },

  previousSibling: {
    get() {
      return tree.Logical.getPreviousSibling(this);
    },
    configurable: true
  },

  nextElementSibling: {
    get() {
      return tree.Logical.getNextElementSibling(this);
    },
    configurable: true
  },

  previousElementSibling: {
    get() {
      return tree.Logical.getPreviousElementSibling(this);
    },
    configurable: true
  },

  assignedSlot: {
    get() {
      return this._assignedSlot;
    },
    configurable: true
  }
});

let ParentNodeMixin = {
  
  append(...nodes) {
    const node = convertNodesIntoANode(nodes, this.ownerDocument);
    return this.insertBefore(node);
  },

  prepend(...nodes) {
    const node = convertNodesIntoANode(nodes, this.ownerDocument);
    return this.insertBefore(node, this.firstChild);
  }

};

Object.defineProperties(ParentNodeMixin, {

  children: {
    get() {
      if (tree.Logical.hasChildNodes(this)) {
        return Array.prototype.filter.call(this.childNodes, function(n) {
          return (n.nodeType === Node.ELEMENT_NODE);
        });
      } else {
        return tree.arrayCopyChildren(this);
      }
    },
    configurable: true
  },

  firstElementChild: {
    get() {
      return tree.Logical.getFirstElementChild(this);
    },
    configurable: true
  },

  lastElementChild: {
    get() {
      return tree.Logical.getLastElementChild(this);
    },
    configurable: true
  },

  childElementCount: {
    get() {
      let count = 0;
      const childNodes = tree.Logical.getChildNodes(this);
      for (let i = 0; i < childNodes.length; i++) {
        if (childNodes[i].nodeType === Node.ELEMENT_NODE) {
          count++;
        }
      }
      return count;
    },
    configurable: true
  }

});

let ChildNodeMixin = {

  before(...nodes) {
    // https://dom.spec.whatwg.org/#dom-childnode-before
    const parent = this.parentNode;
    if (!parent) {
      return;
    }
    let viablePreviousSibling = this.previousSibling;
    while (viablePreviousSibling && nodes.indexOf(viablePreviousSibling) !== -1) {
      viablePreviousSibling = viablePreviousSibling.previousSibling;
    }
    const node = convertNodesIntoANode(nodes, parent.ownerDocument);
    viablePreviousSibling = viablePreviousSibling ? viablePreviousSibling.nextSibling : parent.firstChild;
    parent.insertBefore(node, viablePreviousSibling);
  },

  after(...nodes) {
    // https://dom.spec.whatwg.org/#dom-childnode-after
    const parent = this.parentNode;
    if (!parent) {
      return;
    }
    let viableNextSibling = this.nextSibling;
    while (viableNextSibling && nodes.indexOf(viableNextSibling) !== -1) {
      viableNextSibling = viableNextSibling.nextSibling;
    }
    const node = convertNodesIntoANode(nodes, parent.ownerDocument);
    parent.insertBefore(node, viableNextSibling);
  },

  replaceWith(...nodes) {
    // https://dom.spec.whatwg.org/#dom-childnode-replacewith
    const parent = this.parentNode;
    if (!parent) {
      return;
    }
    let viableNextSibling = this.nextSibling;
    while (viableNextSibling && nodes.indexOf(viableNextSibling) !== -1) {
      viableNextSibling = viableNextSibling.nextSibling;
    }
    const node = convertNodesIntoANode(nodes, parent.ownerDocument);
    if (this.parentNode === parent) {
      parent.replaceChild(node, this);
    }
    else {
      parent.insertBefore(node, viableNextSibling);
    }
  },

  remove() {
    // https://dom.spec.whatwg.org/#dom-childnode-remove
    const parent = this.parentNode;
    if (!parent) {
      return;
    }
    parent.removeChild(this);
  }

};

let FragmentMixin = {

  appendChild(node) {
    return this.insertBefore(node);
  },

  // cases in which we may not be able to just do standard native call
  // 1. container has a shadyRoot (needsDistribution IFF the shadyRoot
  // has an insertion point)
  // 2. container is a shadyRoot (don't distribute, instead set
  // container to container.host.
  // 3. node is <content> (host of container needs distribution)
  insertBefore(node, ref_node) {
    if (ref_node && tree.Logical.getParentNode(ref_node) !== this) {
      throw Error('The ref_node to be inserted before is not a child ' +
        'of this node');
    }
    // remove node from its current position iff it's in a tree.
    if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      let parent = tree.Logical.getParentNode(node);
      mixinImpl.removeNodeFromParent(node, parent);
    }
    if (!mixinImpl.addNode(this, node, ref_node)) {
      if (ref_node) {
        // if ref_node is an insertion point replace with first distributed node
        let root = mixinImpl.ownerShadyRootForNode(ref_node);
        if (root) {
          ref_node = ref_node.localName === root.getInsertionPointTag() ?
            mixinImpl.firstComposedNode(ref_node) : ref_node;
        }
      }
      // if adding to a shadyRoot, add to host instead
      let container = utils.isShadyRoot(this) ?
        this.host : this;
      if (ref_node) {
        tree.Composed.insertBefore(container, node, ref_node);
      } else {
        tree.Composed.appendChild(container, node);
      }
    }
    mixinImpl._scheduleObserver(this, node);
    return node;
  },

  /**
    Removes the given `node` from the element's `lightChildren`.
    This method also performs dom composition.
  */
  removeChild(node) {
    if (tree.Logical.getParentNode(node) !== this) {
      throw Error('The node to be removed is not a child of this node: ' +
        node);
    }
    if (!mixinImpl.removeNode(node)) {
      // if removing from a shadyRoot, remove form host instead
      let container = utils.isShadyRoot(this) ?
        this.host :
        this;
      // not guaranteed to physically be in container; e.g.
      // undistributed nodes.
      let parent = tree.Composed.getParentNode(node);
      if (container === parent) {
        tree.Composed.removeChild(container, node);
      }
    }
    mixinImpl._scheduleObserver(this, null, node);
    return node;
  },

  replaceChild(node, ref_node) {
    this.insertBefore(node, ref_node);
    this.removeChild(ref_node);
    return node;
  },

  // TODO(sorvell): consider doing native QSA and filtering results.
  querySelector(selector) {
    // match selector and halt on first result.
    let result = mixinImpl.query(this, function(n) {
      return utils.matchesSelector(n, selector);
    }, function(n) {
      return Boolean(n);
    })[0];
    return result || null;
  },

  querySelectorAll(selector) {
    return mixinImpl.query(this, function(n) {
      return utils.matchesSelector(n, selector);
    });
  },

  cloneNode(deep) {
    if (this.localName == 'template') {
      return nativeCloneNode.call(this, deep);
    } else {
      let n = nativeCloneNode.call(this, false);
      if (deep) {
        let c$ = this.childNodes;
        for (let i=0, nc; i < c$.length; i++) {
          nc = c$[i].cloneNode(true);
          n.appendChild(nc);
        }
      }
      return n;
    }
  },

  importNode(externalNode, deep) {
    // for convenience use this node's ownerDoc if the node isn't a document
    let doc = this instanceof Document ? this :
      this.ownerDocument;
    let n = nativeImportNode.call(doc, externalNode, false);
    if (deep) {
      let c$ = tree.Logical.getChildNodes(externalNode);
      utils.common.patchNode(n);
      for (let i=0, nc; i < c$.length; i++) {
        nc = doc.importNode(c$[i], true);
        n.appendChild(nc);
      }
    }
    return n;
  }
};

Object.defineProperties(FragmentMixin, {

  childNodes: {
    get() {
      let c$ = tree.Logical.getChildNodes(this);
      return Array.isArray(c$) ? c$ : tree.arrayCopyChildNodes(this);
    },
    configurable: true
  },

  firstChild: {
    get() {
      return tree.Logical.getFirstChild(this);
    },
    configurable: true
  },

  lastChild: {
    get() {
      return tree.Logical.getLastChild(this);
    },
    configurable: true
  },

  // TODO(srovell): strictly speaking fragments do not have textContent
  // or innerHTML but ShadowRoots do and are not easily distinguishable.
  // textContent / innerHTML
  textContent: {
    get() {
      if (this.childNodes) {
        let tc = [];
        for (let i = 0, cn = this.childNodes, c; (c = cn[i]); i++) {
          if (c.nodeType !== Node.COMMENT_NODE) {
            tc.push(c.textContent);
          }
        }
        return tc.join('');
      }
      return '';
    },
    set(text) {
      mixinImpl.clearNode(this);
      if (text) {
        this.appendChild(document.createTextNode(text));
      }
    },
    configurable: true
  },

  innerHTML: {
    get() {
      return getInnerHTML(this);
    },
    set(text) {
      mixinImpl.clearNode(this);
      let d = document.createElement('div');
      d.innerHTML = text;
      // here, appendChild may move nodes async so we cannot rely
      // on node position when copying
      let c$ = tree.arrayCopyChildNodes(d);
      for (let i=0; i < c$.length; i++) {
        this.appendChild(c$[i]);
      }
    },
    configurable: true
  }

});

let ElementMixin = {

  // TODO(sorvell): should only exist on <slot>
  assignedNodes(options) {
    return (options && options.flatten ? this._distributedNodes :
      this._assignedNodes) || [];
  },


  setAttribute(name, value) {
    nativeSetAttribute.call(this, name, value);
    if (!mixinImpl.maybeDistributeParent(this)) {
      mixinImpl.maybeDistributeAttributeChange(this, name);
    }
  },

  removeAttribute(name) {
    nativeRemoveAttribute.call(this, name);
    if (!mixinImpl.maybeDistributeParent(this)) {
      mixinImpl.maybeDistributeAttributeChange(this, name);
    }
  }

};

Object.defineProperties(ElementMixin, {

  shadowRoot: {
    get() {
      return this.shadyRoot;
    }
  },

  slot: {
    get() {
      return this.getAttribute('slot');
    },
    set(value) {
      this.setAttribute('slot', value);
    }
  }

});

let activeElementDescriptor = {
  get() {
    return mixinImpl.activeElementForNode(this);
  }
}

let ActiveElementMixin = {};
Object.defineProperties(ActiveElementMixin, {
  activeElement: activeElementDescriptor
});

let UnderActiveElementMixin = {};
Object.defineProperties(UnderActiveElementMixin, {
  _activeElement: activeElementDescriptor
});

export let Mixins = {

  CharacterData: utils.extendAll({__patched: 'CharacterData'},
    NodeMixin, ChildNodeMixin),

  Fragment: utils.extendAll({__patched: 'Fragment'},
    NodeMixin, ParentNodeMixin, FragmentMixin, ActiveElementMixin),

  Element: utils.extendAll({__patched: 'Element'},
    NodeMixin, ParentNodeMixin, ChildNodeMixin, FragmentMixin, ElementMixin, ActiveElementMixin),

  // Note: activeElement cannot be patched on document!
  Document: utils.extendAll({__patched: 'Document'},
    NodeMixin, ParentNodeMixin, FragmentMixin, ElementMixin, UnderActiveElementMixin)

};

export let getRootNode = function(node) {
  return mixinImpl.getRootNode(node);
}

export function filterMutations(mutations, target) {
  const targetRootNode = getRootNode(target);
  return mutations.filter(function(mutation) {
    const mutationInScope = (targetRootNode === getRootNode(mutation.target));
    if (mutationInScope && mutation.addedNodes) {
      let nodes = Array.from(mutation.addedNodes).filter(function(n) {
        return (targetRootNode === getRootNode(n));
      });
      Object.defineProperty(mutation, 'addedNodes', {
        value: nodes,
        configurable: true
      });
    }
    return mutationInScope &&
      (!mutation.addedNodes || mutation.addedNodes.length);
  });
}

// const promise = Promise.resolve();

class AsyncObserver {

  constructor() {
    this._scheduled = false;
    this.addedNodes = [];
    this.removedNodes = [];
    this.callbacks = new Set();
  }

  schedule() {
    if (!this._scheduled) {
      this._scheduled = true;
      utils.promish.then(() => {
        this.flush();
      });
    }
  }

  flush() {
    if (this._scheduled) {
      this._scheduled = false;
      let mutations = this.takeRecords();
      if (mutations.length) {
        this.callbacks.forEach(function(cb) {
          cb(mutations);
        });
      }
    }
  }

  takeRecords() {
    if (this.addedNodes.length || this.removedNodes.length) {
      let mutations = [{
        addedNodes: this.addedNodes,
        removedNodes: this.removedNodes
      }];
      this.addedNodes = [];
      this.removedNodes = [];
      return mutations;
    }
    return [];
  }

}

// TODO(sorvell): consider instead polyfilling MutationObserver
// directly so that users do not have to fork their code.
// Supporting the entire api may be challenging: e.g. filtering out
// removed nodes in the wrong scope and seeing non-distributing
// subtree child mutations.
export let observeChildren = function(node, callback) {
  utils.common.patchNode(node);
  if (!node.__dom.observer) {
    node.__dom.observer = new AsyncObserver();
  }
  node.__dom.observer.callbacks.add(callback);
  let observer = node.__dom.observer;
  return {
    _callback: callback,
    _observer: observer,
    _node: node,
    takeRecords() {
      return observer.takeRecords()
    }
  };
}

export let unobserveChildren = function(handle) {
  let observer = handle && handle._observer;
  if (observer) {
    observer.callbacks.delete(handle._callback);
    if (!observer.callbacks.size) {
      handle._node.__dom.observer = null;
    }
  }
}

// https://dom.spec.whatwg.org/#converting-nodes-into-a-node
function convertNodesIntoANode(nodes, document) {
  let node = null;

  for (let i = 0; i < nodes.length; i++) {
    const item = nodes[i];

    if (typeof item === "string") {
      nodes[i] = document.createTextNode(item);
    }
    else if (!(item instanceof Node)) {
      let error = new Error(`Cannot insert an item of type "${typeof item}"`);
      error.name = 'TypeError';
      throw error;
    }
    else {
      let parent = tree.Logical.getParentNode(item);
      mixinImpl.removeNodeFromParent(item, parent);
    }
  }

  if (nodes.length === 1) {
    node = nodes[0];
  }
  else {
    node = document.createDocumentFragment();

    for (let i = 0; i < nodes.length; i++) {
      node.appendChild(nodes[i]);
    }
  }

  return node;
}