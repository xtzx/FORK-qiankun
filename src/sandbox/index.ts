/**
 * @author Kuitos
 * @since 2019-04-11
 */
import type { Freer, Rebuilder, SandBox } from '../interfaces';

import LegacySandbox from './legacy/sandbox';
import ProxySandbox from './proxySandbox';
import SnapshotSandbox from './snapshotSandbox';

import { patchAtBootstrapping, patchAtMounting } from './patchers';

export { getCurrentRunningApp } from './common';
export { css } from './patchers';

/**
 * 生成应用运行时沙箱
 *
 * 沙箱分两个类型：
 * 1. app 环境沙箱
 *  app 环境沙箱是指应用初始化过之后，应用会在什么样的上下文环境运行。每个应用的环境沙箱只会初始化一次，因为子应用只会触发一次 bootstrap 。
 *  子应用在切换时，实际上切换的是 app 环境沙箱。
 *
 * 2. render 沙箱
 *  子应用在 app mount 开始前生成好的的沙箱。每次子应用切换过后，render 沙箱都会重现初始化。
 *
 * 这么设计的目的是为了保证每个子应用切换回来之后，还能运行在应用 bootstrap 之后的环境下。
 */
export function createSandboxContainer(
  // 就是 appInstanceId
  appName: string,
  // 返回组件的 DOM 包裹节点
  elementGetter: () => HTMLElement | ShadowRoot,
  // 是否开启命名空间隔离
  scopedCSS: boolean,
  // 松散沙箱模式
  useLooseSandbox?: boolean,
  // 指定部分特殊的动态加载的微应用资源（css/js) 不被 qiankun 劫持处理
  excludeAssetFilter?: (url: string) => boolean,
  // 未传
  globalContext?: typeof window,
  // 未传
  speedySandBox?: boolean,
) {
  let sandbox: SandBox;

  if (window.Proxy) {
    sandbox = useLooseSandbox
      ? new LegacySandbox(appName, globalContext)
      : new ProxySandbox(appName, globalContext, { speedy: !!speedySandBox });
  } else {
    sandbox = new SnapshotSandbox(appName);
  }

  // 在应用启动时对沙箱进行补丁处理。
  // 它根据沙箱的类型（LegacyProxy、Proxy、Snapshot）选择不同的补丁函数，并返回这些补丁函数的执行结果。
  const bootstrappingFreers = patchAtBootstrapping(
    appName,
    elementGetter,
    sandbox,
    scopedCSS,
    excludeAssetFilter,
    speedySandBox,
  );

  // mounting freers are one-off and should be re-init at every mounting time
  let mountingFreers: Freer[] = [];

  let sideEffectsRebuilders: Rebuilder[] = [];

  // 获取 sandboxContainer.instance.proxy sandboxContainer.mount  sandboxContainer.unmount 用
  return {
    instance: sandbox,

    /**
     * 沙箱被 mount
     * 可能是从 bootstrap 状态进入的 mount
     * 也可能是从 unmount 之后再次唤醒进入 mount
     */
    async mount() {
      /* ------------------------------------------ 因为有上下文依赖（window），以下代码执行顺序不能变 ------------------------------------------ */

      /* ------------------------------------------ 1. 启动/恢复 沙箱------------------------------------------ */
      sandbox.active();

      // 存储了在应用启动（bootstrapping）阶段记录的副作用重建函数
      // 开始是空 unmount 执行后才会有 sideEffectsRebuilders
      const sideEffectsRebuildersAtBootstrapping = sideEffectsRebuilders.slice(0, bootstrappingFreers.length);
      // 存储了在应用挂载（mounting）阶段记录的副作用重建函数
      // 开始是空 unmount 执行后才会有 sideEffectsRebuilders
      const sideEffectsRebuildersAtMounting = sideEffectsRebuilders.slice(bootstrappingFreers.length);

      // must rebuild the side effects which added at bootstrapping firstly to recovery to nature state
      if (sideEffectsRebuildersAtBootstrapping.length) {
        sideEffectsRebuildersAtBootstrapping.forEach((rebuild) => rebuild());
      }

      /* ------------------------------------------ 2. 开启全局变量补丁 ------------------------------------------*/
      // render 沙箱启动时开始劫持各类全局监听，尽量不要在应用初始化阶段有 事件监听/定时器 等副作用
      // 劫持了各类全局监听，并返回了解除劫持的 free 函数。在卸载应用时调用 free 函数解除这些全局监听的劫持行为
      mountingFreers = patchAtMounting(appName, elementGetter, sandbox, scopedCSS, excludeAssetFilter, speedySandBox);

      /* ------------------------------------------ 3. 重置一些初始化时的副作用 ------------------------------------------*/
      // 存在 rebuilder 则表明有些副作用需要重建,,
      if (sideEffectsRebuildersAtMounting.length) {
        sideEffectsRebuildersAtMounting.forEach((rebuild) => rebuild());
      }

      // clean up rebuilders
      sideEffectsRebuilders = [];
    },

    /**
     * 恢复 global 状态，使其能回到应用加载之前的状态
     */
    async unmount() {
      // 卸载时候执行清除副作用函数 同时清除副作用函数会返回一个重建函数,存入
      sideEffectsRebuilders = [...bootstrappingFreers, ...mountingFreers].map((free) => free());

      sandbox.inactive();
    },
  };
}
