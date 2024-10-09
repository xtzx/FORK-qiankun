/**
 * @author Kuitos
 * @since 2019-04-11
 */

import type { Freer, SandBox } from '../../interfaces';
import { SandBoxType } from '../../interfaces';
import * as css from './css';
import { patchLooseSandbox, patchStrictSandbox } from './dynamicAppend';
import patchHistoryListener from './historyListener';
import patchInterval from './interval';
import patchWindowListener from './windowListener';

/**
 * 在应用 mount 时对沙箱进行补丁处理。
 * 返回值是对应沙箱类型的 [...basePatchers, patchStrictSandbox/patchLooseSandbox]
 * 传给 patchLooseSandbox patchStrictSandbox 的 mounting 参数是 true,表示什么不清楚 TODO:
 */
export function patchAtMounting(
  appName: string,
  elementGetter: () => HTMLElement | ShadowRoot,
  sandbox: SandBox,
  scopedCSS: boolean,
  excludeAssetFilter?: CallableFunction,
  speedySandBox?: boolean,
): Freer[] {
  // 基础的补丁函数
  const basePatchers = [
    // 计时器劫持
    () => patchInterval(sandbox.proxy),
    // window 事件监听劫持
    () => patchWindowListener(sandbox.proxy),
    // window.history 事件监听劫持
    () => patchHistoryListener(),
  ];

  const patchersInSandbox = {
    [SandBoxType.LegacyProxy]: [
      ...basePatchers,
      () => patchLooseSandbox(appName, elementGetter, sandbox, true, scopedCSS, excludeAssetFilter),
    ],
    [SandBoxType.Proxy]: [
      ...basePatchers,
      () => patchStrictSandbox(appName, elementGetter, sandbox, true, scopedCSS, excludeAssetFilter, speedySandBox),
    ],
    [SandBoxType.Snapshot]: [
      ...basePatchers,
      () => patchLooseSandbox(appName, elementGetter, sandbox, true, scopedCSS, excludeAssetFilter),
    ],
  };

  return patchersInSandbox[sandbox.type]?.map((patch) => patch());
}

/**
 * 在应用 mount 时对沙箱进行补丁处理。
 * 返回值是对应沙箱类型的 [patchStrictSandbox/patchLooseSandbox]
 * 和 patchAtMounting 相比就是少了 basePatchers 以及 mounting 参数相反
 * 传给 patchLooseSandbox patchStrictSandbox 的 mounting 参数是 false,表示什么不清楚 TODO:
 *
 * 包括 动态添加样式表和脚本文件劫持
 * 返回值是根据沙箱类型分别返回 patchLooseSandbox() 和 patchStrictSandbox() 的执行结果
 */
export function patchAtBootstrapping(
  appName: string,
  elementGetter: () => HTMLElement | ShadowRoot,
  sandbox: SandBox,
  scopedCSS: boolean,
  excludeAssetFilter?: CallableFunction,
  speedySandBox?: boolean,
): Freer[] {
  const patchersInSandbox = {
    [SandBoxType.LegacyProxy]: [
      () => patchLooseSandbox(appName, elementGetter, sandbox, false, scopedCSS, excludeAssetFilter),
    ],
    [SandBoxType.Proxy]: [
      () => patchStrictSandbox(appName, elementGetter, sandbox, false, scopedCSS, excludeAssetFilter, speedySandBox),
    ],
    [SandBoxType.Snapshot]: [
      () => patchLooseSandbox(appName, elementGetter, sandbox, false, scopedCSS, excludeAssetFilter),
    ],
  };

  return patchersInSandbox[sandbox.type]?.map((patch) => patch());
}

export { css };
