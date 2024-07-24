/**
 * @author Kuitos
 * @since 2020-04-0
 */

import { importEntry } from 'import-html-entry';
import { concat, forEach, mergeWith } from 'lodash';
import type { LifeCycles, ParcelConfigObject } from 'single-spa';
import getAddOns from './addons';
import { QiankunError } from './error';
import { getMicroAppStateActions } from './globalState';
import type {
  FrameworkConfiguration,
  FrameworkLifeCycles,
  HTMLContentRender,
  LifeCycleFn,
  LoadableApp,
  ObjectType,
} from './interfaces';
import { createSandboxContainer, css } from './sandbox';
import { cachedGlobals } from './sandbox/proxySandbox';
import {
  Deferred,
  genAppInstanceIdByName,
  getContainer,
  getDefaultTplWrapper,
  getWrapperId,
  isEnableScopedCSS,
  performanceGetEntriesByName,
  performanceMark,
  performanceMeasure,
  toArray,
  validateExportLifecycle,
} from './utils';

type ElementRender = (
  props: { element: HTMLElement | null; loading: boolean; container?: string | HTMLElement },
  phase: 'loading' | 'mounting' | 'mounted' | 'unmounted',
) => any;

export type ParcelConfigObjectGetter = (remountContainer?: string | HTMLElement) => ParcelConfigObject;

const rawAppendChild = HTMLElement.prototype.appendChild;
const rawRemoveChild = HTMLElement.prototype.removeChild;
let prevAppUnmountedDeferred: Deferred<void>;

// 检查浏览器是否支持 Shadow DOM
const supportShadowDOM = !!document.head.attachShadow || !!(document.head as any).createShadowRoot;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * @description: 确保传入的元素存在。如果元素不存在，则抛出一个自定义错误 QiankunError，并且可以选择性地提供一个错误消息。
 * @param {Element} element
 * @param {string} msg
 */
function assertElementExist(element: Element | null | undefined, msg?: string) {
  if (!element) {
    if (msg) {
      throw new QiankunError(msg);
    }

    throw new QiankunError('element not existed!');
  }
}

/**
 * @description: 按顺序执行一系列生命周期钩子函数，并确保这些钩子函数按顺序执行
 * hooks: 一个包含生命周期钩子函数的数组,每个钩子函数需要是异步的
 * app: 一个表示可加载应用的对象。
 * global: 一个全局对象，默认为 window。
 */
function execHooksChain<T extends ObjectType>(
  hooks: Array<LifeCycleFn<T>>,
  app: LoadableApp<T>,
  global = window,
): Promise<any> {
  if (hooks.length) {
    // reduce 方法从一个已解决的 Promise 开始，然后依次将每个钩子函数添加到链中。每个钩子函数在前一个钩子函数完成后执行。
    return hooks.reduce((chain, hook) => chain.then(() => hook(app, global)), Promise.resolve());
  }

  // 检查 hooks 数组是否为空。如果为空，直接返回一个已解决的 Promise。
  return Promise.resolve();
}

/**
 * @description:validate 如果是函数则执行否则当作 boolean 处理
 */
async function validateSingularMode<T extends ObjectType>(
  validate: FrameworkConfiguration['singular'],
  app: LoadableApp<T>,
): Promise<boolean> {
  return typeof validate === 'function' ? validate(app) : !!validate;
}

/**
 * @description:据 appContent 创建一个容器元素，并根据 strictStyleIsolation 和 scopedCSS 的配置对元素进行处理。
 * @param appContent  HTML 内容插入到容器 注意应当是一个单节点
 * @param strictStyleIsolation 严格样式隔离
 * @param scopedCSS 启用了 scopedCSS
 * @param appInstanceId
 */
function createElement(
  appContent: string,
  strictStyleIsolation: boolean,
  scopedCSS: boolean,
  appInstanceId: string,
): HTMLElement {
  // 创建容器元素：将 appContent 插入到一个新的 div 元素中。
  // 用于临时存放 appContent，以便从中提取出第一个子元素 appElement。
  const containerElement = document.createElement('div');
  containerElement.innerHTML = appContent;
  // 获取容器中的第一个子元素，即 appContent 的根元素
  const appElement = containerElement.firstChild as HTMLElement;

  // 如果启用了严格样式隔离
  if (strictStyleIsolation) {
    if (!supportShadowDOM) {
      console.warn(
        '[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!',
      );
    } else {
      const { innerHTML } = appElement;
      appElement.innerHTML = '';
      let shadow: ShadowRoot;

      // 如果 appElement 支持 attachShadow 方法
      if (appElement.attachShadow) {
        // 创建一个开放模式的 Shadow DOM
        shadow = appElement.attachShadow({ mode: 'open' });
      } else {
        // 否则使用已弃用的 createShadowRoot 方法创建 Shadow DOM
        shadow = (appElement as any).createShadowRoot();
      }
      shadow.innerHTML = innerHTML;
    }
  }

  // 如果开启了 css 命名空间功能,则根据 QiankunCSSRewriteAttr || appInstanceId 给 class 添加前缀
  if (scopedCSS) {
    const attr = appElement.getAttribute(css.QiankunCSSRewriteAttr);
    if (!attr) {
      appElement.setAttribute(css.QiankunCSSRewriteAttr, appInstanceId);
    }

    const styleNodes = appElement.querySelectorAll('style') || [];
    forEach(styleNodes, (stylesheetElement: HTMLStyleElement) => {
      css.process(appElement!, stylesheetElement, appInstanceId);
    });
  }

  return appElement;
}

/**
 * @description: 返回一个函数,函数返回的是:
 * 如果有 app.render 就返回 id 是  `__qiankun_microapp_wrapper_for_${snakeCase(name)}__`; 的 DOM
 * 否则是新版渲染函数 返回参数 elementGetter 的结果
 * @param appInstanceId 应用实例 ID
 * @param useLegacyRender 等于 app.render 表示是否使用旧版渲染函数
 * @param strictStyleIsolation 是否启用严格样式隔离
 * @param scopedCSS 是否启用了 scopedCSS
 * @param elementGetter 获取元素的函数
 */
function getAppWrapperGetter(
  appInstanceId: string,
  useLegacyRender: boolean,
  strictStyleIsolation: boolean,
  scopedCSS: boolean,
  elementGetter: () => HTMLElement | null,
) {
  return () => {
    // 如果使用旧版渲染函数
    if (useLegacyRender) {
      if (strictStyleIsolation) throw new QiankunError('strictStyleIsolation can not be used with legacy render!');
      if (scopedCSS) throw new QiankunError('experimentalStyleIsolation can not be used with legacy render!');

      // __qiankun_microapp_wrapper_for_develop_1721721434018_898__
      const appWrapper = document.getElementById(getWrapperId(appInstanceId));
      assertElementExist(appWrapper, `Wrapper element for ${appInstanceId} is not existed!`);
      return appWrapper!;
    }

    const element = elementGetter();
    assertElementExist(element, `Wrapper element for ${appInstanceId} is not existed!`);

    if (strictStyleIsolation && supportShadowDOM) {
      return element!.shadowRoot!;
    }

    return element!;
  };
}

/**
 * 返回一个函数 render,功能是: 添加 element 进入 container 中
 * 函数返回的是:
 * 如果有 app.render 直接返回它
 * 否则通过参数 container 字段获取到 DDM,然后判断当前是生命周期阶段以及 element 是否存在 container 中
 */
function getRender(appInstanceId: string, appContent: string, legacyRender?: HTMLContentRender) {
  const render: ElementRender = ({ element, loading, container }, phase) => {
    // 如果提供了旧版渲染函数
    if (legacyRender) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[qiankun] 自定义渲染函数已弃用，将在 3.0 版本中移除，您可以使用容器元素设置代替！');
      }

      // 调用旧版渲染函数并返回结果
      return legacyRender({ loading, appContent: element ? appContent : '' });
    }

    const containerElement = getContainer(container!);

    // 容器可能在微应用卸载后被移除
    // 例如，微应用卸载生命周期在 React 组件的 componentWillUnmount 生命周期中调用，微应用卸载后，React 组件也可能被移除
    if (phase !== 'unmounted') {
      const errorMsg = (() => {
        switch (phase) {
          case 'loading':
          case 'mounting':
            return `Target container with ${container} not existed while ${appInstanceId} ${phase}!`;

          case 'mounted':
            return `Target container with ${container} not existed after ${appInstanceId} ${phase}!`;

          default:
            return `Target container with ${container} not existed while ${appInstanceId} rendering!`;
        }
      })();

      // 断言容器元素存在，否则抛出错误
      assertElementExist(containerElement, errorMsg);
    }

    // 如果容器元素存在且不包含当前元素
    if (containerElement && !containerElement.contains(element)) {
      // 清空容器
      while (containerElement!.firstChild) {
        rawRemoveChild.call(containerElement, containerElement!.firstChild);
      }

      // 如果元素存在，将其附加到容器中
      if (element) {
        rawAppendChild.call(containerElement, element);
      }
    }

    return undefined;
  };

  return render;
}

/**
 * @description: 从传入的 scriptExports 对象中提取生命周期函数
 * 如果 scriptExports 中没有有效的生命周期函数，
 * 它会尝试从全局对象 sandboxContainer?.instance?.latestSetProp (这个应该是原本 window 对象上的属性) 中获取。
 * 如果仍然没有找到，它会抛出一个自定义错误 QiankunError。
 */
function getLifecyclesFromExports(
  scriptExports: LifeCycles<any>,
  appName: string,
  global: WindowProxy,
  globalLatestSetProp?: PropertyKey | null,
) {
  // 验证 scriptExports 是否包含有效的生命周期函数：
  if (validateExportLifecycle(scriptExports)) {
    return scriptExports;
  }

  // fallback to sandbox latest set property if it had
  if (globalLatestSetProp) {
    const lifecycles = (<any>global)[globalLatestSetProp];
    if (validateExportLifecycle(lifecycles)) {
      return lifecycles;
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.warn(
      `[qiankun] lifecycle not found from ${appName} entry exports, fallback to get from window['${appName}']`,
    );
  }

  // fallback to global variable who named with ${appName} while module exports not found
  const globalVariableExports = (global as any)[appName];

  if (validateExportLifecycle(globalVariableExports)) {
    return globalVariableExports;
  }

  throw new QiankunError(`You need to export lifecycle functions in ${appName} entry`);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * @description: 加载微应用的核心函数
 * 内部实现了 html 的装载,脚本的下载和执行
 * 但是子应用脚本的 bootstrap 实际上没执行而是作为返回值
 *
 * 本身只是加载,不会渲染到页面上
 * 当微应用信息注册完之后，一旦浏览器的 url 发生变化，便会自动触发 qiankun 的匹配逻辑，
 * 所有 activeRule 规则匹配上的微应用就会被插入到指定的 container 中，同时依次调用微应用暴露出的生命周期钩子。
 */
export async function loadApp<T extends ObjectType>(
  // 这样一个对象
  // {
  //   name: 'vueApp',
  //   entry: '//localhost:7200',
  //   container: '#container',
  //   activeRule: '/vue',
  // },
  app: LoadableApp<T>,
  // 基本上是 frameworkConfiguration 字段, 是 start 时候初始化的
  configuration: FrameworkConfiguration = {},
  // 可选，全局的微应用生命周期钩子
  lifeCycles?: FrameworkLifeCycles<T>,
): Promise<ParcelConfigObjectGetter> {
  const { entry, name: appName } = app;
  // 生成应用实例 ID 结构是 appName_(这个appName出现的次数 - 1)
  const appInstanceId = genAppInstanceIdByName(appName);

  const markName = `[qiankun] App ${appInstanceId} Loading`;
  if (process.env.NODE_ENV === 'development') {
    performanceMark(markName);
  }

  const {
    // boolean | ((app: RegistrableApp<any>) => Promise<boolean>); - 可选，是否为单实例场景，单实例指的是同一时间只会渲染一个微应用。
    // start 函数默认 true
    // loadMicroApp 函数默认 false
    singular = false,
    // 可选，是否开启沙箱，默认为 true。
    // 默认情况下沙箱可以确保单实例场景子应用之间的样式隔离，但是无法确保主应用跟子应用、或者多实例场景的子应用样式隔离。
    // 当配置为 { strictStyleIsolation: true } 时表示开启严格的样式隔离模式。
    // 这种模式下 qiankun 会为每个微应用的容器包裹上一个 shadow dom 节点，从而确保微应用的样式不会对全局造成影响。
    sandbox = true,
    // 可选，指定部分特殊的动态加载的微应用资源（css/js) 不被 qiankun 劫持处理
    excludeAssetFilter,
    // 这个字段现在不知道从何而来,看着就是指定的 window,属于 QiankunSpecialOpts
    globalContext = window,
    ...importEntryOpts
  } = configuration;

  // 获取入口 HTML 内容和脚本执行器
  const { template, execScripts, assetPublicPath, getExternalScripts } = await importEntry(entry, importEntryOpts);
  // 触发外部脚本加载，确保在调用 execScripts 之前所有资源都已准备好
  // getExternalScripts 调用的是内部的 _getExternalScripts(scripts, fetch);
  await getExternalScripts();

  // 在单实例模式下，等待所有应用卸载完成后再加载新应用
  // (see https://github.com/CanopyTax/single-spa/blob/master/src/navigation/reroute.js#L74)
  if (await validateSingularMode(singular, app)) {
    await (prevAppUnmountedDeferred && prevAppUnmountedDeferred.promise);
  }

  // 修改 template 内容
  const appContent = getDefaultTplWrapper(appInstanceId, sandbox)(template);
  // 判断是否启用严格样式隔离
  // 这种模式下 qiankun 会为每个微应用的容器包裹上一个 shadow dom 节点，从而确保微应用的样式不会对全局造成影响。
  const strictStyleIsolation = typeof sandbox === 'object' && !!sandbox.strictStyleIsolation;

  if (process.env.NODE_ENV === 'development' && strictStyleIsolation) {
    console.warn(
      "[qiankun] strictStyleIsolation configuration will be removed in 3.0, pls don't depend on it or use experimentalStyleIsolation instead!",
    );
  }

  // 判断是否启用 scoped CSS strictStyleIsolation是 false experimentalStyleIsolation 是 true
  const scopedCSS = isEnableScopedCSS(sandbox);
  // 将字符串 appContent 变成一个 DOM 节点 appContent被包装过 肯定是单节点
  let initialAppWrapperElement: HTMLElement | null = createElement(
    // 包装后的通过 importEntry 获得的 template 字符串
    appContent,
    // sandbox.strictStyleIsolation
    strictStyleIsolation,
    // css 命名空间功能
    scopedCSS,
    appInstanceId,
  );

  const initialContainer = 'container' in app ? app.container : undefined;
  const legacyRender = 'render' in app ? app.render : undefined;

  const render = getRender(appInstanceId, appContent, legacyRender);

  // 将 initialAppWrapperElement 渲染到 initialContainer 中
  //  loading 是 phase 字段含义,用枚举更好
  render({ element: initialAppWrapperElement, loading: true, container: initialContainer }, 'loading');

  // -----------------------------------------------------------------------------
  // 到目前为止, entry 对应的 DOM 节点,已经被包裹 + 处理样式隔离并且渲染到 app.container 中
  // -----------------------------------------------------------------------------

  // legacyRender 模式返回 getWrapperId 对应的 DOM id
  // 其他返回 initialAppWrapperElement
  // 主要判断是否渲染到页面上
  const initialAppWrapperGetter = getAppWrapperGetter(
    appInstanceId,
    !!legacyRender,
    strictStyleIsolation,
    scopedCSS,
    () => initialAppWrapperElement,
  );

  let global = globalContext;
  let mountSandbox = () => Promise.resolve();
  let unmountSandbox = () => Promise.resolve();

  // 判断是否使用松散沙箱模式 已经弃用 loose,改成默认严格模式
  // 所以这个字段以后都是 false
  const useLooseSandbox = typeof sandbox === 'object' && !!sandbox.loose;
  // 判断是否使用快速沙箱模式 speedy 配置没有在文档上看过
  const speedySandbox = typeof sandbox === 'object' ? sandbox.speedy !== false : true;

  let sandboxContainer;

  // TODO:后面看看这个逻辑
  if (sandbox) {
    sandboxContainer = createSandboxContainer(
      appInstanceId,
      // FIXME should use a strict sandbox logic while remount, see https://github.com/umijs/qiankun/issues/518
      initialAppWrapperGetter,
      scopedCSS,
      useLooseSandbox,
      excludeAssetFilter,
      global,
      speedySandbox,
    );
    // 用沙箱的代理对象作为接下来使用的全局对象
    global = sandboxContainer.instance.proxy as typeof window;
    mountSandbox = sandboxContainer.mount;
    unmountSandbox = sandboxContainer.unmount;
  }

  // 合并生命周期钩子
  const {
    beforeUnmount = [],
    afterUnmount = [],
    afterMount = [],
    beforeMount = [],
    beforeLoad = [],
  } = mergeWith({}, getAddOns(global, assetPublicPath), lifeCycles, (v1, v2) => concat(v1 ?? [], v2 ?? []));

  // 执行 beforeLoad 钩子
  // TODO:确认:这个时候子应用的html(无js)已经被渲染了,资源已经加载了,js未执行
  await execHooksChain(toArray(beforeLoad), app, global);

  // 执行脚本并获取导出的生命周期函数
  const scriptExports: any = await execScripts(global, sandbox && !useLooseSandbox, {
    scopedGlobalVariables: speedySandbox ? cachedGlobals : [],
  });

  // 从导出的脚本中获取生命周期函数
  const { bootstrap, mount, unmount, update } = getLifecyclesFromExports(
    scriptExports,
    appName,
    global,
    sandboxContainer?.instance?.latestSetProp,
  );

  // 获取微应用状态管理的相关函数
  const { onGlobalStateChange, setGlobalState, offGlobalStateChange }: Record<string, CallableFunction> =
    getMicroAppStateActions(appInstanceId);

  // 同步应用包装元素到沙箱
  const syncAppWrapperElement2Sandbox = (element: HTMLElement | null) => (initialAppWrapperElement = element);

  // loadMicroApp 会使用这个返回值
  const parcelConfigGetter: ParcelConfigObjectGetter = (remountContainer = initialContainer) => {
    let appWrapperElement: HTMLElement | null;
    let appWrapperGetter: ReturnType<typeof getAppWrapperGetter>;

    const parcelConfig: ParcelConfigObject = {
      name: appInstanceId,
      bootstrap,
      mount: [
        // 环境检查和性能标记
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const marks = performanceGetEntriesByName(markName, 'mark');
            // mark length is zero means the app is remounting
            if (marks && !marks.length) {
              performanceMark(markName);
            }
          }
        },
        // 验证单例模式：验证应用是否处于单例模式。如果是单例模式且之前的应用卸载延迟对象存在，返回该延迟对象的 Promise。
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            return prevAppUnmountedDeferred.promise;
          }

          return undefined;
        },
        // 初始化应用包装元素
        async () => {
          appWrapperElement = initialAppWrapperElement;
          appWrapperGetter = getAppWrapperGetter(
            appInstanceId,
            !!legacyRender,
            strictStyleIsolation,
            scopedCSS,
            () => appWrapperElement,
          );
        },
        // 添加 mount hook, 确保每次应用加载前容器 dom 结构已经设置完毕
        async () => {
          const useNewContainer = remountContainer !== initialContainer;
          if (useNewContainer || !appWrapperElement) {
            // element will be destroyed after unmounted, we need to recreate it if it not exist
            // or we try to remount into a new container
            appWrapperElement = createElement(appContent, strictStyleIsolation, scopedCSS, appInstanceId);
            syncAppWrapperElement2Sandbox(appWrapperElement);
          }

          render({ element: appWrapperElement, loading: true, container: remountContainer }, 'mounting');
        },
        // 挂载沙箱
        mountSandbox,
        // 执行挂载前的钩子函数链
        async () => execHooksChain(toArray(beforeMount), app, global),
        // 挂载应用，传入必要的属性和容器
        async (props) => mount({ ...props, container: appWrapperGetter(), setGlobalState, onGlobalStateChange }),
        //渲染应用包装元素，显示加载完成状态
        async () => render({ element: appWrapperElement, loading: false, container: remountContainer }, 'mounted'),
        // 执行挂载后的钩子函数链。
        async () => execHooksChain(toArray(afterMount), app, global),
        // 如果是单例模式，初始化卸载延迟对象。
        async () => {
          if (await validateSingularMode(singular, app)) {
            prevAppUnmountedDeferred = new Deferred<void>();
          }
        },
        // 性能测量
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const measureName = `[qiankun] App ${appInstanceId} Loading Consuming`;
            performanceMeasure(measureName, markName);
          }
        },
      ],
      unmount: [
        // 执行 beforeUnmount 钩子函数链
        async () => execHooksChain(toArray(beforeUnmount), app, global),
        // 卸载应用，传递必要的属性
        async (props) => unmount({ ...props, container: appWrapperGetter() }),
        // 卸载沙箱环境
        unmountSandbox,
        // 执行 afterUnmount 钩子函数链
        async () => execHooksChain(toArray(afterUnmount), app, global),
        // 渲染空的元素，表示应用已卸载，并取消全局状态变化监听
        async () => {
          render({ element: null, loading: false, container: remountContainer }, 'unmounted');
          offGlobalStateChange(appInstanceId);
          // 为了垃圾回收，将应用包装元素置为空
          appWrapperElement = null;
          syncAppWrapperElement2Sandbox(appWrapperElement);
        },
        // 验证单例模式，如果满足条件，解决前一个应用卸载的延迟对象
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            prevAppUnmountedDeferred.resolve();
          }
        },
      ],
    };

    if (typeof update === 'function') {
      parcelConfig.update = update;
    }

    return parcelConfig;
  };

  // 返回值 - MicroApp - 微应用实例
  // mount(): Promise<null>;
  // unmount(): Promise<null>;
  // update(customProps: object): Promise<any>;
  // getStatus(): | "NOT_LOADED" | "LOADING_SOURCE_CODE" | "NOT_BOOTSTRAPPED" | "BOOTSTRAPPING" | "NOT_MOUNTED" | "MOUNTING" | "MOUNTED" | "UPDATING" | "UNMOUNTING" | "UNLOADING" | "SKIP_BECAUSE_BROKEN" | "LOAD_ERROR";
  // loadPromise: Promise<null>;
  // bootstrapPromise: Promise<null>;
  // mountPromise: Promise<null>;
  // unmountPromise: Promise<null>;
  return parcelConfigGetter;
}
