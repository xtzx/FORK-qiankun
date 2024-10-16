/**
 * @author Kuitos
 * @since 2020-10-13
 */

import type { Freer, SandBox } from '../../../interfaces';
import { isBoundedFunction, isCallable, nativeDocument, nativeGlobal } from '../../../utils';
import { getCurrentRunningApp } from '../../common';
import type { ContainerConfig } from './common';
import {
  calcAppCount,
  getAppWrapperHeadElement,
  isAllAppsUnmounted,
  isHijackingTag,
  patchHTMLDynamicAppendPrototypeFunctions,
  rebuildCSSRules,
  recordStyledComponentsCSSRules,
  styleElementRefNodeNo,
  styleElementTargetSymbol,
} from './common';

const elementAttachedSymbol = Symbol('attachedApp');
declare global {
  interface HTMLElement {
    [elementAttachedSymbol]: string;
  }
}

// Get native global window with a sandbox disgusted way, thus we could share it between qiankun instances🤪
Object.defineProperty(nativeGlobal, '__proxyAttachContainerConfigMap__', { enumerable: false, writable: true });

Object.defineProperty(nativeGlobal, '__currentLockingSandbox__', {
  enumerable: false,
  writable: true,
  configurable: true,
});

const rawHeadAppendChild = HTMLHeadElement.prototype.appendChild;
const rawHeadInsertBefore = HTMLHeadElement.prototype.insertBefore;

// Share proxyAttachContainerConfigMap between multiple qiankun instance, thus they could access the same record
nativeGlobal.__proxyAttachContainerConfigMap__ =
  nativeGlobal.__proxyAttachContainerConfigMap__ || new WeakMap<WindowProxy, ContainerConfig>();
const proxyAttachContainerConfigMap: WeakMap<WindowProxy, ContainerConfig> =
  nativeGlobal.__proxyAttachContainerConfigMap__;

/**
 * 将每个 HTMLElement 和其所属的子应用（通过 ContainerConfig）进行关联
 * 通过 document.createElement 创建的元素
 */
const elementAttachContainerConfigMap = new WeakMap<HTMLElement, ContainerConfig>();

const docCreatePatchedMap = new WeakMap<typeof document.createElement, typeof document.createElement>();
const patchMap = new WeakMap<any, any>();





/**
 */
function patchDocument(cfg: { sandbox: SandBox; speedy: boolean }) {
  const { sandbox, speedy } = cfg;

  const attachElementToProxy = (element: HTMLElement, proxy: Window) => {
    const proxyContainerConfig = proxyAttachContainerConfigMap.get(proxy);
    if (proxyContainerConfig) {
      elementAttachContainerConfigMap.set(element, proxyContainerConfig);
    }
  };

  if (speedy) {
    const modifications: {
      createElement?: typeof document.createElement;
      querySelector?: typeof document.querySelector;
    } = {};

    const proxyDocument = new Proxy(document, {
      /**
       * Read and write must be paired, otherwise the write operation will leak to the global
       */
      set: (target, p, value) => {
        switch (p) {
          case 'createElement': {
            modifications.createElement = value;
            break;
          }
          case 'querySelector': {
            modifications.querySelector = value;
            break;
          }
          default:
            (<any>target)[p] = value;
            break;
        }

        return true;
      },
      get: (target, p, receiver) => {
        switch (p) {
          case 'createElement': {
            // Must store the original createElement function to avoid error in nested sandbox
            const targetCreateElement = modifications.createElement || target.createElement;
            return function createElement(...args: Parameters<typeof document.createElement>) {
              if (!nativeGlobal.__currentLockingSandbox__) {
                nativeGlobal.__currentLockingSandbox__ = sandbox.name;
              }

              const element = targetCreateElement.call(target, ...args);

              // only record the element which is created by the current sandbox, thus we can avoid the element created by nested sandboxes
              if (nativeGlobal.__currentLockingSandbox__ === sandbox.name) {
                attachElementToProxy(element, sandbox.proxy);
                delete nativeGlobal.__currentLockingSandbox__;
              }

              return element;
            };
          }

          case 'querySelector': {
            const targetQuerySelector = modifications.querySelector || target.querySelector;
            return function querySelector(...args: Parameters<typeof document.querySelector>) {
              const selector = args[0];
              switch (selector) {
                case 'head': {
                  const containerConfig = proxyAttachContainerConfigMap.get(sandbox.proxy);
                  if (containerConfig) {
                    const qiankunHead = getAppWrapperHeadElement(containerConfig.appWrapperGetter());
                    qiankunHead.appendChild = HTMLHeadElement.prototype.appendChild;
                    qiankunHead.insertBefore = HTMLHeadElement.prototype.insertBefore;
                    qiankunHead.removeChild = HTMLHeadElement.prototype.removeChild;
                    return qiankunHead;
                  }
                  break;
                }
              }

              return targetQuerySelector.call(target, ...args);
            };
          }
          default:
            break;
        }

        const value = (<any>target)[p];
        // must rebind the function to the target otherwise it will cause illegal invocation error
        if (isCallable(value) && !isBoundedFunction(value)) {
          return function proxyFunction(...args: unknown[]) {
            return value.call(target, ...args.map((arg) => (arg === receiver ? target : arg)));
          };
        }

        return value;
      },
    });

    sandbox.patchDocument(proxyDocument);

    // patch MutationObserver.prototype.observe to avoid type error
    // https://github.com/umijs/qiankun/issues/2406
    // 获取原生 MutationObserver.observe 方法，后续我们需要对这个方法进行重写（劫持）
    const nativeMutationObserverObserveFn = MutationObserver.prototype.observe;

    // 未劫持
    if (!patchMap.has(nativeMutationObserverObserveFn)) {
      const observe = function observe(this: MutationObserver, target: Node, options: MutationObserverInit) {
        // 因为在沙箱环境中，document 可能已经被代理成 proxyDocument，所以需要确保观察的目标节点是正确的。
        // 保沙箱内的 document 操作不会影响全局的 document 对象。
        const realTarget = target instanceof Document ? nativeDocument : target;
        return nativeMutationObserverObserveFn.call(this, realTarget, options);
      };

      MutationObserver.prototype.observe = observe;
      patchMap.set(nativeMutationObserverObserveFn, observe);
    }

    // patch Node.prototype.compareDocumentPosition to avoid type error
    // 类似
    const prevCompareDocumentPosition = Node.prototype.compareDocumentPosition;
    if (!patchMap.has(prevCompareDocumentPosition)) {
      Node.prototype.compareDocumentPosition = function compareDocumentPosition(this: Node, node) {
        const realNode = node instanceof Document ? nativeDocument : node;
        return prevCompareDocumentPosition.call(this, realNode);
      };
      patchMap.set(prevCompareDocumentPosition, Node.prototype.compareDocumentPosition);
    }

    // patch parentNode getter to avoid document === html.parentNode
    // https://github.com/umijs/qiankun/issues/2408#issuecomment-1446229105
    const parentNodeDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'parentNode');

    if (parentNodeDescriptor && !patchMap.has(parentNodeDescriptor)) {
      const { get: parentNodeGetter, configurable } = parentNodeDescriptor;
      if (parentNodeGetter && configurable) {
        const patchedParentNodeDescriptor = {
          ...parentNodeDescriptor,
          get(this: Node) {
            const parentNode = parentNodeGetter.call(this);
            if (parentNode instanceof Document) {
              const proxy = getCurrentRunningApp()?.window;
              if (proxy) {
                return proxy.document;
              }
            }

            return parentNode;
          },
        };
        Object.defineProperty(Node.prototype, 'parentNode', patchedParentNodeDescriptor);

        patchMap.set(parentNodeDescriptor, patchedParentNodeDescriptor);
      }
    }

    return () => {
      MutationObserver.prototype.observe = nativeMutationObserverObserveFn;
      patchMap.delete(nativeMutationObserverObserveFn);

      Node.prototype.compareDocumentPosition = prevCompareDocumentPosition;
      patchMap.delete(prevCompareDocumentPosition);

      if (parentNodeDescriptor) {
        Object.defineProperty(Node.prototype, 'parentNode', parentNodeDescriptor);
        patchMap.delete(parentNodeDescriptor);
      }
    };
  }

  //  非 speed 模式

  const docCreateElementFnBeforeOverwrite = docCreatePatchedMap.get(document.createElement);
  // 缓存判断
  if (!docCreateElementFnBeforeOverwrite) {
    const rawDocumentCreateElement = document.createElement;
    // 重写 document.createElement
    Document.prototype.createElement = function createElement<K extends keyof HTMLElementTagNameMap>(
      this: Document,
      tagName: K,
      options?: ElementCreationOptions,
    ): HTMLElement {
      const element = rawDocumentCreateElement.call(this, tagName, options);
      if (isHijackingTag(tagName)) {
        const { window: currentRunningSandboxProxy } = getCurrentRunningApp() || {};
        if (currentRunningSandboxProxy) {
          attachElementToProxy(element, currentRunningSandboxProxy);
        }
      }

      return element;
    };

    // document 本身是从 Document.prototype 继承的，正常情况下 createElement 是定义在 Document.prototype 上的。
    // 如果 document 对象本身没有 createElement 属性（即继承自 Document.prototype），直接修改 Document.prototype 即可。
    // 但是如果 document 对象本身存在 createElement 属性（意味着它被某些情况下重写了），我们需要将其重新赋值为我们自定义的 createElement。
    if (document.hasOwnProperty('createElement')) {
      document.createElement = Document.prototype.createElement;
    }

    docCreatePatchedMap.set(Document.prototype.createElement, rawDocumentCreateElement);
  }

  return function unpatch() {
    if (docCreateElementFnBeforeOverwrite) {
      Document.prototype.createElement = docCreateElementFnBeforeOverwrite;
      document.createElement = docCreateElementFnBeforeOverwrite;
    }
  };
}

export function patchStrictSandbox(
  appName: string,
  appWrapperGetter: () => HTMLElement | ShadowRoot,
  sandbox: SandBox,
  mounting = true,
  scopedCSS = false,
  excludeAssetFilter?: CallableFunction,
  speedySandbox = false,
): Freer {
  const { proxy } = sandbox;
  let containerConfig = proxyAttachContainerConfigMap.get(proxy);
  if (!containerConfig) {
    containerConfig = {
      appName,
      proxy,
      appWrapperGetter,
      dynamicStyleSheetElements: [],
      strictGlobal: true,
      speedySandbox,
      excludeAssetFilter,
      scopedCSS,
    };
    proxyAttachContainerConfigMap.set(proxy, containerConfig);
  }
  // all dynamic style sheets are stored in proxy container
  const { dynamicStyleSheetElements } = containerConfig;

  // TODO: elementAttachContainerConfigMap 没有删除逻辑 不知道此处有没有问题
  const unpatchDynamicAppendPrototypeFunctions = patchHTMLDynamicAppendPrototypeFunctions(
    (element) => elementAttachContainerConfigMap.has(element),
    (element) => elementAttachContainerConfigMap.get(element)!,
  );

  const unpatchDocument = patchDocument({ sandbox, speedy: speedySandbox });

  if (!mounting) calcAppCount(appName, 'increase', 'bootstrapping');
  if (mounting) calcAppCount(appName, 'increase', 'mounting');

  return function free() {
    if (!mounting) calcAppCount(appName, 'decrease', 'bootstrapping');
    if (mounting) calcAppCount(appName, 'decrease', 'mounting');

    // release the overwritten prototype after all the micro apps unmounted
    if (isAllAppsUnmounted()) {
      unpatchDynamicAppendPrototypeFunctions();
      unpatchDocument();
    }

    recordStyledComponentsCSSRules(dynamicStyleSheetElements);

    // As now the sub app content all wrapped with a special id container,
    // the dynamic style sheet would be removed automatically while unmoutting

    return function rebuild() {
      rebuildCSSRules(dynamicStyleSheetElements, (stylesheetElement) => {
        const appWrapper = appWrapperGetter();
        if (!appWrapper.contains(stylesheetElement)) {
          const mountDom =
            stylesheetElement[styleElementTargetSymbol] === 'head' ? getAppWrapperHeadElement(appWrapper) : appWrapper;
          const refNo = stylesheetElement[styleElementRefNodeNo];

          if (typeof refNo === 'number' && refNo !== -1) {
            // the reference node may be dynamic script comment which is not rebuilt while remounting thus reference node no longer exists
            const refNode = mountDom.childNodes[refNo] || null;
            rawHeadInsertBefore.call(mountDom, stylesheetElement, refNode);
            return true;
          } else {
            rawHeadAppendChild.call(mountDom, stylesheetElement);
            return true;
          }
        }

        return false;
      });
    };
  };
}
