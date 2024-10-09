/**
 * @author Kuitos
 * @since 2020-10-13
 */

import { checkActivityFunctions } from 'single-spa';
import type { Freer, SandBox } from '../../../interfaces';
import {
  calcAppCount,
  isAllAppsUnmounted,
  patchHTMLDynamicAppendPrototypeFunctions,
  rebuildCSSRules,
  recordStyledComponentsCSSRules,
} from './common';

/**
 * 适用于 Snapshot 和 LegacyProxy 两种比较简单的沙箱模型
 *
 * 劫持动态插入到 <head> 元素中的样式表，以避免意外劫持除 <head> 之外的元素插入。
 * 这在某些情况下非常有用，例如使用 ReactDOM.createPortal 将样式元素插入到特定容器中时，如果不进行劫持，可能会导致在 React Portal 卸载时出现错误，
 * 因为 ReactDOM 无法在 body 子元素列表中找到样式。
 *
 * 劫持动态样式表插入：确保动态插入的样式表仅限于 <head> 元素，避免影响其他元素的插入。
 * 记录和管理动态样式表：在沙箱运行期间，记录所有动态插入的样式表元素，以便在沙箱卸载时进行清理和重建。
 * 应用计数管理：在应用启动和挂载时，增加应用计数；在应用卸载时，减少应用计数。
 * 重建样式表：在应用重新挂载时，重建之前记录的动态样式表，确保样式表能够正确应用。
 */
export function patchLooseSandbox(
  appName: string,
  appWrapperGetter: () => HTMLElement | ShadowRoot,
  sandbox: SandBox,
  mounting = true,
  scopedCSS = false,
  excludeAssetFilter?: CallableFunction,
): Freer {
  const { proxy } = sandbox;

  let dynamicStyleSheetElements: Array<HTMLLinkElement | HTMLStyleElement> = [];

  // 使用 patchHTMLDynamicAppendPrototypeFunctions 函数劫持动态插入的样式表元素，并记录这些元素。
  // 劫持函数会检查当前指定的应用是否处于活动状态，避免在页面切换时误记录其他应用的样式表。
  const unpatchDynamicAppendPrototypeFunctions = patchHTMLDynamicAppendPrototypeFunctions(
    // 检查当前指定的应用程序是否处于活动状态
    // 当我们从qiankun app切换页面到普通的React路由页面时，普通的React路由页面可能会在页面渲染时动态加载样式表，
    // 但 url 更改侦听器必须等到当前调用堆栈被刷新。
    // 这种情况可能会导致我们记录React路由页面动态注入的样式表，
    // 并在触发 url 更改且 qiankun 应用卸载后删除它们
    () => checkActivityFunctions(window.location).some((name) => name === appName),
    () => ({
      appName,
      appWrapperGetter,
      proxy,
      strictGlobal: false,
      speedySandbox: false,
      scopedCSS,
      dynamicStyleSheetElements,
      excludeAssetFilter,
    }),
  );

  // 在挂载和启动阶段，分别调用 calcAppCount 函数增加应用计数。
  if (!mounting) calcAppCount(appName, 'increase', 'bootstrapping');
  // 在卸载阶段，调用 calcAppCount 减少应用计数。
  if (mounting) calcAppCount(appName, 'increase', 'mounting');

  /**
   * 这个是卸载阶段的清理功能
   * 存了一份 cssRules，在重新挂载的时候会执行 rebuild 函数将其还原。
   * 这是因为样式元素 DOM 从文档中删除后，浏览器会自动清除样式元素表。如果不这么做的话，在重新挂载时会出现存在 style 标签，但是没有渲染样式的问题。
   */
  return function free() {
    if (!mounting) calcAppCount(appName, 'decrease', 'bootstrapping');
    if (mounting) calcAppCount(appName, 'decrease', 'mounting');

    // 在卸载时，调用 unpatchDynamicAppendPrototypeFunctions 释放劫持的原型函数。
    if (isAllAppsUnmounted()) unpatchDynamicAppendPrototypeFunctions();

    // 调用 recordStyledComponentsCSSRules 记录样式表规则。
    recordStyledComponentsCSSRules(dynamicStyleSheetElements);

    // As now the sub app content all wrapped with a special id container,
    // the dynamic style sheet would be removed automatically while unmounting

    // 返回一个 rebuild 函数，用于在应用重新挂载时重建样式表。
    // rebuild 函数会遍历记录的样式表元素，并将其重新插入到应用包裹节点中。
    return function rebuild() {
      rebuildCSSRules(dynamicStyleSheetElements, (stylesheetElement) => {
        const appWrapper = appWrapperGetter();
        if (!appWrapper.contains(stylesheetElement)) {
          // Using document.head.appendChild ensures that appendChild invocation can also directly use the HTMLHeadElement.prototype.appendChild method which is overwritten at mounting phase
          document.head.appendChild.call(appWrapper, stylesheetElement);
          return true;
        }

        return false;
      });

      // As the patcher will be invoked every mounting phase, we could release the cache for gc after rebuilding
      if (mounting) {
        dynamicStyleSheetElements = [];
      }
    };
  };
}
