/**
 * @author Kuitos
 * @since 2019-10-21
 */
import { execScripts } from 'import-html-entry';
import { isFunction } from 'lodash';
import { frameworkConfiguration } from '../../../apis';
import { qiankunHeadTagName } from '../../../utils';
import { cachedGlobals } from '../../proxySandbox';
import * as css from '../css';

const SCRIPT_TAG_NAME = 'SCRIPT';
const LINK_TAG_NAME = 'LINK';
const STYLE_TAG_NAME = 'STYLE';

export const styleElementTargetSymbol = Symbol('target');
export const styleElementRefNodeNo = Symbol('refNodeNo');
const overwrittenSymbol = Symbol('qiankun-overwritten');

type DynamicDomMutationTarget = 'head' | 'body';

declare global {
  interface HTMLLinkElement {
    [styleElementTargetSymbol]: DynamicDomMutationTarget;
    [styleElementRefNodeNo]?: Exclude<number, -1>;
  }

  interface HTMLStyleElement {
    [styleElementTargetSymbol]: DynamicDomMutationTarget;
    [styleElementRefNodeNo]?: Exclude<number, -1>;
  }

  interface Function {
    [overwrittenSymbol]: boolean;
  }
}

/**
 * 返回子应用 html 中被单独处理过的 head 元素
 */
export const getAppWrapperHeadElement = (appWrapper: Element | ShadowRoot): Element => {
  return appWrapper.querySelector(qiankunHeadTagName)!;
};

/**
 * 用于判断给定的  <script> 元素是否包含可执行的脚本类型
 */
export function isExecutableScriptType(script: HTMLScriptElement) {
  return (
    // 如果 script.type 是空字符串或者 null（即没有明确指定 type），函数将返回 true。这意味着默认的脚本类型是可执行的（通常指的是 JavaScript）。
    !script.type ||
    // 这些值表示不同语法和用途的可执行脚本类型。
    ['text/javascript', 'module', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].indexOf(
      script.type,
    ) !== -1
  );
}

/**
 * 判断是否是 link、style、script 标签
 */
export function isHijackingTag(tagName?: string) {
  return (
    tagName?.toUpperCase() === LINK_TAG_NAME ||
    tagName?.toUpperCase() === STYLE_TAG_NAME ||
    tagName?.toUpperCase() === SCRIPT_TAG_NAME
  );
}

/**
 * Check if a style element is a styled-component liked.
 * A styled-components liked element is which not have textContext but keep the rules in its styleSheet.cssRules.
 * Such as the style element generated by styled-components and emotion.
 * @param element
 */
export function isStyledComponentsLike(element: HTMLStyleElement) {
  return (
    !element.textContent &&
    ((element.sheet as CSSStyleSheet)?.cssRules.length || getStyledElementCSSRules(element)?.length)
  );
}

const appsCounterMap = new Map<string, { bootstrappingPatchCount: number; mountingPatchCount: number }>();

export function calcAppCount(
  appName: string,
  calcType: 'increase' | 'decrease',
  status: 'bootstrapping' | 'mounting',
): void {
  const appCount = appsCounterMap.get(appName) || { bootstrappingPatchCount: 0, mountingPatchCount: 0 };
  switch (calcType) {
    case 'increase':
      appCount[`${status}PatchCount`] += 1;
      break;
    case 'decrease':
      // bootstrap patch just called once but its freer will be called multiple times
      if (appCount[`${status}PatchCount`] > 0) {
        appCount[`${status}PatchCount`] -= 1;
      }
      break;
  }
  appsCounterMap.set(appName, appCount);
}

export function isAllAppsUnmounted(): boolean {
  return Array.from(appsCounterMap.entries()).every(
    ([, { bootstrappingPatchCount: bpc, mountingPatchCount: mpc }]) => bpc === 0 && mpc === 0,
  );
}

function patchCustomEvent(
  e: CustomEvent,
  elementGetter: () => HTMLScriptElement | HTMLLinkElement | null,
): CustomEvent {
  Object.defineProperties(e, {
    srcElement: {
      get: elementGetter,
    },
    target: {
      get: elementGetter,
    },
  });

  return e;
}

function manualInvokeElementOnLoad(element: HTMLLinkElement | HTMLScriptElement) {
  // we need to invoke the onload event manually to notify the event listener that the script was completed
  // here are the two typical ways of dynamic script loading
  // 1. element.onload callback way, which webpack and loadjs used, see https://github.com/muicss/loadjs/blob/master/src/loadjs.js#L138
  // 2. addEventListener way, which toast-loader used, see https://github.com/pyrsmk/toast/blob/master/src/Toast.ts#L64
  const loadEvent = new CustomEvent('load');
  const patchedEvent = patchCustomEvent(loadEvent, () => element);
  if (isFunction(element.onload)) {
    element.onload(patchedEvent);
  } else {
    element.dispatchEvent(patchedEvent);
  }
}

function manualInvokeElementOnError(element: HTMLLinkElement | HTMLScriptElement) {
  const errorEvent = new CustomEvent('error');
  const patchedEvent = patchCustomEvent(errorEvent, () => element);
  if (isFunction(element.onerror)) {
    element.onerror(patchedEvent);
  } else {
    element.dispatchEvent(patchedEvent);
  }
}

/**
 * createElement 一个 style 标签然后下载传入的 link 标签的样式表并转换为 style 标签
 */
function convertLinkAsStyle(
  element: HTMLLinkElement,
  postProcess: (styleElement: HTMLStyleElement) => void,
  fetchFn = fetch,
): HTMLStyleElement {
  const styleElement = document.createElement('style');
  const { href } = element;
  // add source link element href
  styleElement.dataset.qiankunHref = href;

  fetchFn(href)
    .then((res: any) => res.text())
    .then((styleContext: string) => {
      styleElement.appendChild(document.createTextNode(styleContext));
      postProcess(styleElement);
      manualInvokeElementOnLoad(element);
    })
    .catch(() => manualInvokeElementOnError(element));

  return styleElement;
}

/**
 * 定义目标对象的属性为不可枚举
 */
const defineNonEnumerableProperty = (target: any, key: string | symbol, value: any) => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
};

const styledComponentCSSRulesMap = new WeakMap<HTMLStyleElement, CSSRuleList>();
const dynamicScriptAttachedCommentMap = new WeakMap<HTMLScriptElement, Comment>();
const dynamicLinkAttachedInlineStyleMap = new WeakMap<HTMLLinkElement, HTMLStyleElement>();

export function recordStyledComponentsCSSRules(styleElements: HTMLStyleElement[]): void {
  styleElements.forEach((styleElement) => {
    /*
     With a styled-components generated style element, we need to record its cssRules for restore next re-mounting time.
     We're doing this because the sheet of style element is going to be cleaned automatically by browser after the style element dom removed from document.
     see https://www.w3.org/TR/cssom-1/#associated-css-style-sheet
     */
    if (styleElement instanceof HTMLStyleElement && isStyledComponentsLike(styleElement)) {
      if (styleElement.sheet) {
        // record the original css rules of the style element for restore
        styledComponentCSSRulesMap.set(styleElement, (styleElement.sheet as CSSStyleSheet).cssRules);
      }
    }
  });
}

export function getStyledElementCSSRules(styledElement: HTMLStyleElement): CSSRuleList | undefined {
  return styledComponentCSSRulesMap.get(styledElement);
}

export type ContainerConfig = {
  appName: string;
  proxy: WindowProxy;
  strictGlobal: boolean;
  speedySandbox: boolean;
  dynamicStyleSheetElements: Array<HTMLStyleElement | HTMLLinkElement>;
  appWrapperGetter: CallableFunction;
  scopedCSS: boolean;
  excludeAssetFilter?: CallableFunction;
};

/**
 * 劫持和重写 HTML 元素（如 <head> 和 <body>）的 appendChild 和 insertBefore 方法
 * 返回值是一个 appendChildOrInsertBefore 函数,函数的 [overwrittenSymbol] = true
 * 返回值相当于 insertBefore 和 appendChild 方法
 */
function getOverwrittenAppendChildOrInsertBefore(opts: {
  // rawDOMAppendOrInsertBefore: 原始的 appendChild 或 insertBefore 方法。
  rawDOMAppendOrInsertBefore: <T extends Node>(newChild: T, refChild?: Node | null) => T;
  // 检查当前指定的应用程序是否处于活动状态
  isInvokedByMicroApp: (element: HTMLElement) => boolean;
  // 一个函数，用于获取子应用的容器。
  containerConfigGetter: (element: HTMLElement) => ContainerConfig;
  // 动态 DOM 操作的目标（如 head 或 body）。
  target: DynamicDomMutationTarget;
}) {
  /**
   * 本函数是新的 insertBefore 和 appendChild 方法
   */
  function appendChildOrInsertBefore<T extends Node>(
    // 这个 this 参数实际上是 TypeScript 中的一种特殊用法，用于指定函数在调用时的上下文对象。
    // 并不是函数的实际参数，而是用于类型检查的。
    this: HTMLHeadElement | HTMLBodyElement,
    newChild: T,
    refChild: Node | null = null,
  ) {
    let element = newChild as any;
    const { rawDOMAppendOrInsertBefore, isInvokedByMicroApp, containerConfigGetter, target = 'body' } = opts;

    // 检查元素的 tagName 是否需要劫持或者非激活状态
    // 判断子应用的激活状态主要是因为：当主应用切换路由时可能会自动添加动态样式表，此时需要避免主应用的样式表被添加到子应用head节点中导致出错
    if (!isHijackingTag(element.tagName) || !isInvokedByMicroApp(element)) {
      return rawDOMAppendOrInsertBefore.call(this, element, refChild) as T;
    }

    if (element.tagName) {
      const containerConfig = containerConfigGetter(element);
      const {
        appName,
        appWrapperGetter,
        proxy,
        strictGlobal,
        speedySandbox,
        dynamicStyleSheetElements,
        scopedCSS,
        excludeAssetFilter,
      } = containerConfig;

      switch (element.tagName) {
        // 一起处理 link 和 style 标签
        // 动态 style 样式表就会被添加到子应用容器内
        // 在子应用卸载时样式表也可以和子应用一起被卸载，从而避免样式污染。
        // 同时，动态样式表也会存储在 dynamicStyleSheetElements 数组中，
        case LINK_TAG_NAME:
        case STYLE_TAG_NAME: {
          let stylesheetElement: HTMLLinkElement | HTMLStyleElement = newChild as any;
          const { href } = stylesheetElement as HTMLLinkElement;

          // 函数会检查是否需要排除某些资源,这个是业务方配置的
          if (excludeAssetFilter && href && excludeAssetFilter(href)) {
            return rawDOMAppendOrInsertBefore.call(this, element, refChild) as T;
          }

          defineNonEnumerableProperty(stylesheetElement, styleElementTargetSymbol, target);

          const appWrapper = appWrapperGetter();

          if (scopedCSS) {
            // exclude link elements like <link rel="icon" href="favicon.ico">
            const linkElementUsingStylesheet =
              element.tagName?.toUpperCase() === LINK_TAG_NAME &&
              (element as HTMLLinkElement).rel === 'stylesheet' &&
              (element as HTMLLinkElement).href;
            if (linkElementUsingStylesheet) {
              const fetch =
                typeof frameworkConfiguration.fetch === 'function'
                  ? frameworkConfiguration.fetch
                  : frameworkConfiguration.fetch?.fn;

              // 下载 + 转换
              stylesheetElement = convertLinkAsStyle(
                element,
                (styleElement) => css.process(appWrapper, styleElement, appName),
                fetch,
              );
              dynamicLinkAttachedInlineStyleMap.set(element, stylesheetElement);
            } else {
              css.process(appWrapper, stylesheetElement, appName);
            }
          }

          const mountDOM = target === 'head' ? getAppWrapperHeadElement(appWrapper) : appWrapper;

          const referenceNode = mountDOM.contains(refChild) ? refChild : null;

          let refNo: number | undefined;
          if (referenceNode) {
            refNo = Array.from(mountDOM.childNodes).indexOf(referenceNode);
          }

          // 将通过命名空间转换后的样式表插入 appWrapper 中
          const result = rawDOMAppendOrInsertBefore.call(mountDOM, stylesheetElement, referenceNode);

          // record refNo thus we can keep order while remounting
          if (typeof refNo === 'number' && refNo !== -1) {
            defineNonEnumerableProperty(stylesheetElement, styleElementRefNodeNo, refNo);
          }
          // record dynamic style elements after insert succeed
          dynamicStyleSheetElements.push(stylesheetElement);

          return result as T;
        }

        // 单独处理 script 标签
        // 主要就是根据 excludeAssetFilter 判断插入原始 html 中还是子应用的 html 中
        // 对动态添加的脚本进行劫持的主要目的就是为了将动态脚本运行时的 window 对象替换成 proxy 代理对象，使子应用动态添加的脚本文件的运行上下文也替换成子应用自身。
        case SCRIPT_TAG_NAME: {
          // 从插入的元素中提取 src 和 text 属性，这两个属性分别代表外部脚本的 URL 和内联脚本的内容。
          // script 标签自带的属性
          const { src, text } = element as HTMLScriptElement;

          // 配置了不使用劫持的资源会按照默认逻辑插入
          // 某些脚本（例如 jsonp）可能不支持 cors，因此不应使用 execScripts
          // JSONP（JSON with Padding）是一种传统的跨域请求手段，通过动态插入 <script> 标签实现跨域数据访问。JSONP 不受同源策略的限制，但它只能用来 GET 请求，并且只能返回 JavaScript 代码。JSONP 不支持 HTTP 请求头，因此也不支持 CORS（跨来源资源共享）
          if ((excludeAssetFilter && src && excludeAssetFilter(src)) || !isExecutableScriptType(element)) {
            return rawDOMAppendOrInsertBefore.call(this, element, refChild) as T;
          }

          const appWrapper = appWrapperGetter();
          const mountDOM = target === 'head' ? getAppWrapperHeadElement(appWrapper) : appWrapper;

          const { fetch } = frameworkConfiguration;
          const referenceNode = mountDOM.contains(refChild) ? refChild : null;

          const scopedGlobalVariables = speedySandbox ? cachedGlobals : [];

          if (src) {
            let isRedfinedCurrentScript = false;

            // 对外部引入的 script 脚本文件使用 fetch 获取，然后使用 execScripts 指定 proxy 对象（作为 window 对象）后执行脚本文件内容
            // 同时也触发了 load 和 error 两个事件。
            execScripts(null, [src], proxy, {
              fetch,
              strictGlobal,
              scopedGlobalVariables,
              beforeExec: () => {
                const isCurrentScriptConfigurable = () => {
                  // 通过删除和重新定义 document.currentScript，确保脚本在正确的上下文中执行
                  const descriptor = Object.getOwnPropertyDescriptor(document, 'currentScript');
                  return !descriptor || descriptor.configurable;
                };

                if (isCurrentScriptConfigurable()) {
                  Object.defineProperty(document, 'currentScript', {
                    get(): any {
                      return element;
                    },
                    configurable: true,
                  });
                  isRedfinedCurrentScript = true;
                }
              },
              success: () => {
                manualInvokeElementOnLoad(element);
                if (isRedfinedCurrentScript) {
                  // @ts-ignore
                  delete document.currentScript;
                }
                element = null;
              },
              error: () => {
                manualInvokeElementOnError(element);
                if (isRedfinedCurrentScript) {
                  // @ts-ignore
                  delete document.currentScript;
                }
                element = null;
              },
            });

            // 无论是外部脚本还是内联脚本，都会在 DOM 中插入一个注释节点，标记脚本已被替换。这些注释节点用于调试和跟踪动态插入的脚本
            const dynamicScriptCommentElement = document.createComment(`dynamic script ${src} replaced by qiankun`);

            dynamicScriptAttachedCommentMap.set(element, dynamicScriptCommentElement);
            return rawDOMAppendOrInsertBefore.call(mountDOM, dynamicScriptCommentElement, referenceNode);
          }

          // 如果脚本没有 src 属性（即内联脚本），则直接通过 execScripts 函数执行内联脚本内容。
          // 内联脚本不会触发 onload 和 onerror 事件，因此需要通过注释的方式替换脚本内容，以便后续处理。
          execScripts(null, [`<script>${text}</script>`], proxy, { strictGlobal, scopedGlobalVariables });

          const dynamicInlineScriptCommentElement = document.createComment('dynamic inline script replaced by qiankun');
          dynamicScriptAttachedCommentMap.set(element, dynamicInlineScriptCommentElement);

          return rawDOMAppendOrInsertBefore.call(mountDOM, dynamicInlineScriptCommentElement, referenceNode);
        }

        default:
          break;
      }
    }

    return rawDOMAppendOrInsertBefore.call(this, element, refChild);
  }

  appendChildOrInsertBefore[overwrittenSymbol] = true;

  return appendChildOrInsertBefore;
}

/**
 * 劫持和重写 <head> 和 <body> 的 removeChild 方法
 * 类似 getOverwrittenAppendChildOrInsertBefore
 */
function getNewRemoveChild(
  rawRemoveChild: typeof HTMLElement.prototype.removeChild,
  containerConfigGetter: (element: HTMLElement) => ContainerConfig,
  target: DynamicDomMutationTarget,
  isInvokedByMicroApp: (element: HTMLElement) => boolean,
) {
  function removeChild<T extends Node>(this: HTMLHeadElement | HTMLBodyElement, child: T) {
    const { tagName } = child as any;
    if (!isHijackingTag(tagName) || !isInvokedByMicroApp(child as any)) return rawRemoveChild.call(this, child) as T;

    try {
      let attachedElement: Node;
      const { appWrapperGetter, dynamicStyleSheetElements } = containerConfigGetter(child as any);

      switch (tagName) {
        case STYLE_TAG_NAME:
        case LINK_TAG_NAME: {
          attachedElement = dynamicLinkAttachedInlineStyleMap.get(child as any) || child;

          // try to remove the dynamic style sheet
          const dynamicElementIndex = dynamicStyleSheetElements.indexOf(attachedElement as HTMLLinkElement);
          if (dynamicElementIndex !== -1) {
            dynamicStyleSheetElements.splice(dynamicElementIndex, 1);
          }

          break;
        }

        case SCRIPT_TAG_NAME: {
          attachedElement = dynamicScriptAttachedCommentMap.get(child as any) || child;
          break;
        }

        default: {
          attachedElement = child;
        }
      }

      const appWrapper = appWrapperGetter();
      const container = target === 'head' ? getAppWrapperHeadElement(appWrapper) : appWrapper;
      // container might have been removed while app unmounting if the removeChild action was async
      if (container.contains(attachedElement)) {
        return rawRemoveChild.call(attachedElement.parentNode, attachedElement) as T;
      }
    } catch (e) {
      console.warn(e);
    }

    return rawRemoveChild.call(this, child) as T;
  }

  removeChild[overwrittenSymbol] = true;
  return removeChild;
}

/**
 * 劫持和重写 <head> 和 <body> 的动态插入和移除操作
 * 通过重写 appendChild、insertBefore 和 removeChild 方法来实现
 *
 * 技术细节
 * Symbol 标记：使用 Symbol 来标记已经被重写的方法，避免重复重写。
 * WeakMap：使用 WeakMap 来存储和管理与元素相关的配置信息，确保这些信息在元素被垃圾回收时自动清理。
 * 通过 HTMLHeadElement.prototype 实现重载
 */
export function patchHTMLDynamicAppendPrototypeFunctions(
  isInvokedByMicroApp: (element: HTMLElement) => boolean,
  containerConfigGetter: (element: HTMLElement) => ContainerConfig,
) {
  const rawHeadAppendChild = HTMLHeadElement.prototype.appendChild;
  const rawBodyAppendChild = HTMLBodyElement.prototype.appendChild;
  const rawHeadInsertBefore = HTMLHeadElement.prototype.insertBefore;

  // 检查是否已经重写：通过检查这些方法是否已经被重写，避免重复重写。
  if (
    rawHeadAppendChild[overwrittenSymbol] !== true &&
    rawBodyAppendChild[overwrittenSymbol] !== true &&
    rawHeadInsertBefore[overwrittenSymbol] !== true
  ) {
    HTMLHeadElement.prototype.appendChild = getOverwrittenAppendChildOrInsertBefore({
      rawDOMAppendOrInsertBefore: rawHeadAppendChild,
      containerConfigGetter,
      isInvokedByMicroApp,
      target: 'head',
    }) as typeof rawHeadAppendChild;
    HTMLBodyElement.prototype.appendChild = getOverwrittenAppendChildOrInsertBefore({
      rawDOMAppendOrInsertBefore: rawBodyAppendChild,
      containerConfigGetter,
      isInvokedByMicroApp,
      target: 'body',
    }) as typeof rawBodyAppendChild;

    HTMLHeadElement.prototype.insertBefore = getOverwrittenAppendChildOrInsertBefore({
      rawDOMAppendOrInsertBefore: rawHeadInsertBefore as any,
      containerConfigGetter,
      isInvokedByMicroApp,
      target: 'head',
    }) as typeof rawHeadInsertBefore;
  }

  const rawHeadRemoveChild = HTMLHeadElement.prototype.removeChild;
  const rawBodyRemoveChild = HTMLBodyElement.prototype.removeChild;
  // Just overwrite it while it have not been overwritten
  if (rawHeadRemoveChild[overwrittenSymbol] !== true && rawBodyRemoveChild[overwrittenSymbol] !== true) {
    HTMLHeadElement.prototype.removeChild = getNewRemoveChild(
      rawHeadRemoveChild,
      containerConfigGetter,
      'head',
      isInvokedByMicroApp,
    );
    HTMLBodyElement.prototype.removeChild = getNewRemoveChild(
      rawBodyRemoveChild,
      containerConfigGetter,
      'body',
      isInvokedByMicroApp,
    );
  }

  // 返回取消劫持的函数：函数返回一个 unpatch 函数，用于恢复原始的 appendChild、insertBefore 和 removeChild 方法。
  return function unpatch() {
    HTMLHeadElement.prototype.appendChild = rawHeadAppendChild;
    HTMLHeadElement.prototype.removeChild = rawHeadRemoveChild;
    HTMLBodyElement.prototype.appendChild = rawBodyAppendChild;
    HTMLBodyElement.prototype.removeChild = rawBodyRemoveChild;

    HTMLHeadElement.prototype.insertBefore = rawHeadInsertBefore;
  };
}

export function rebuildCSSRules(
  styleSheetElements: HTMLStyleElement[],
  reAppendElement: (stylesheetElement: HTMLStyleElement) => boolean,
) {
  styleSheetElements.forEach((stylesheetElement) => {
    // re-append the dynamic stylesheet to sub-app container
    const appendSuccess = reAppendElement(stylesheetElement);
    if (appendSuccess) {
      /*
      get the stored css rules from styled-components generated element, and the re-insert rules for them.
      note that we must do this after style element had been added to document, which stylesheet would be associated to the document automatically.
      check the spec https://www.w3.org/TR/cssom-1/#associated-css-style-sheet
       */
      if (stylesheetElement instanceof HTMLStyleElement && isStyledComponentsLike(stylesheetElement)) {
        const cssRules = getStyledElementCSSRules(stylesheetElement);
        if (cssRules) {
          // eslint-disable-next-line no-plusplus
          for (let i = 0; i < cssRules.length; i++) {
            const cssRule = cssRules[i];
            const cssStyleSheetElement = stylesheetElement.sheet as CSSStyleSheet;
            cssStyleSheetElement.insertRule(cssRule.cssText, cssStyleSheetElement.cssRules.length);
          }
        }
      }
    }
  });
}
