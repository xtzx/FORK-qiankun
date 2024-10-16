/**
 * @author Saviio
 * @since 2020-4-19
 * 通过作用域隔离来处理 CSS，避免多个应用的样式冲突问题
 */

// https://developermozilla.org/en-US/docs/Web/API/CSSRule
enum RuleType {
  // type: rule will be rewrote
  STYLE = 1,
  MEDIA = 4,
  SUPPORTS = 12,

  // type: value will be kept
  IMPORT = 3,
  FONT_FACE = 5,
  PAGE = 6,
  KEYFRAMES = 7,
  KEYFRAME = 8,
}

/**
 * 将类数组对象（如 CSSRuleList）转换为真正的数组
 */
const arrayify = <T>(list: CSSRuleList | any[]) => {
  return [].slice.call(list, 0) as T[];
};

const rawDocumentBodyAppend = HTMLBodyElement.prototype.appendChild;

/**
 * ⚠️⚠️⚠️ 核心实现
 *
 */
export class ScopedCSS {
  // 用于标记某个 styleNode 是否已经被处理过，避免重复处理
  private static ModifiedTag = 'Symbol(style-modified-qiankun)';

  // 临时存储和处理样式，借助 StyleSheet 对象来读取和修改样式规则。
  private sheet: StyleSheet;
  private swapNode: HTMLStyleElement;

  constructor() {
    const styleNode = document.createElement('style');
    rawDocumentBodyAppend.call(document.body, styleNode);

    this.swapNode = styleNode;
    this.sheet = styleNode.sheet!;
    this.sheet.disabled = true;
  }

  /**
   * 处理一个 styleNode（也就是 style 标签），并对其内容进行样式隔离
   */
  process(styleNode: HTMLStyleElement, prefix: string = '') {
    // 已经处理过就结束
    if (ScopedCSS.ModifiedTag in styleNode) {
      return;
    }

    /**
     * 获取或设置 HTML 元素文本内容的属性
     * 是 DOM API 的一部分，允许开发者以字符串的形式访问和修改元素的文本内容。
     * 获取 style 标签中的 CSS 文本，处理后替换为带有前缀的 CSS
     */
    if (styleNode.textContent !== '') {
      // CSS 规则需要在 DOM 上被渲染（sheet 属性仅当样式被挂载后才能访问）
      const textNode = document.createTextNode(styleNode.textContent || '');
      this.swapNode.appendChild(textNode);
      const sheet = this.swapNode.sheet as any;
      // 使用 swapNode 创建临时 style 节点来获取样式表 (StyleSheet) 对象。
      // 通过 StyleSheet，可以访问 cssRules，从而获取具体的 CSS 规则。
      const rules = arrayify<CSSRule>(sheet?.cssRules ?? []);
      const css = this.rewrite(rules, prefix);
      styleNode.textContent = css;

      // 清理临时的节点，避免内存泄露
      this.swapNode.removeChild(textNode);
      (styleNode as any)[ScopedCSS.ModifiedTag] = true;
      return;
    }

    /**
     * 通过 MutationObserver 监听 style 标签的变化，并在变化时重新处理样式。
     * 监听的是 styleNode 的子节点变
     */
    const mutator = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i += 1) {
        const mutation = mutations[i];

        if (ScopedCSS.ModifiedTag in styleNode) {
          return;
        }

        if (mutation.type === 'childList') {
          const sheet = styleNode.sheet as any;
          const rules = arrayify<CSSRule>(sheet?.cssRules ?? []);
          const css = this.rewrite(rules, prefix);

          styleNode.textContent = css;
          (styleNode as any)[ScopedCSS.ModifiedTag] = true;
        }
      }
    });

    // since observer will be deleted when node be removed
    // we dont need create a cleanup function manually
    // see https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/disconnect
    // 有办法可以逃逸 mutator.observe 的监听
    // 直接操作 styleNode.sheet.insertRule 插入样式规则，而不是修改 textContent，就不会触发 MutationObserver
    // 删除属性或直接操作 sheet：可以直接通过 styleNode.sheet 操作 CSS 规则（如 insertRule、deleteRule），这种操作不会触发 MutationObserver 的 childList 监听
    mutator.observe(styleNode, { childList: true });
  }

  /**
   * 负责处理一组 CSS 规则，并根据 RuleType 对应的 CSS 规则类型，决定如何处理这些规则。
   */
  private rewrite(rules: CSSRule[], prefix: string = '') {
    let css = '';

    // 包括普通样式规则（STYLE）、媒体查询（MEDIA）和功能查询（SUPPORTS）。对于不支持处理的类型，直接返回 cssText。
    // 其他类型的规则：
    // @font-face、@keyframes、@import 等规则：这些规则本质上是定义全局的资源（如字体、动画等），它们通常不受 DOM 层级影响。
    // 因此，给这些规则加作用域前缀是没有意义的。这也是为什么不处理它们的原因。
    rules.forEach((rule) => {
      switch (rule.type) {
        case RuleType.STYLE:
          css += this.ruleStyle(rule as CSSStyleRule, prefix);
          break;
        case RuleType.MEDIA:
          css += this.ruleMedia(rule as CSSMediaRule, prefix);
          break;
        case RuleType.SUPPORTS:
          css += this.ruleSupport(rule as CSSSupportsRule, prefix);
          break;
        default:
          if (typeof rule.cssText === 'string') {
            css += `${rule.cssText}`;
          }

          break;
      }
    });

    return css;
  }

  // handle case:
  // .app-main {}
  // html, body {}

  /**
   * 用于处理具体的 CSSStyleRule，即普通样式规则。通过分析选择器的类型，决定如何加上前缀。
   */
  private ruleStyle(rule: CSSStyleRule, prefix: string) {
    const rootSelectorRE = /((?:[^\w\-.#]|^)(body|html|:root))/gm;
    const rootCombinationRE = /(html[^\w{[]+)/gm;

    // 虽然 CSS 选择器通常不会以空格或换行开始或结束，但在某些情况下（如误用格式化工具或手动添加换行符等）可能会导致意外的空白字符。
    // 为了确保选择器格式一致且不受空白字符干扰，trim 是一种安全处理措施，虽然大多数情况下不必要，但它可以防止潜在问题。
    const selector = rule.selectorText.trim();

    let cssText = '';
    // 理论上，它始终应该是字符串，但检查类型是一种防御性编程方式，以防止出现某些异常情况（如浏览器的不一致行为或兼容性问题）
    if (typeof rule.cssText === 'string') {
      cssText = rule.cssText;
    }

    /**
     * 匹配根元素选择器：对 html、body、:root 等选择器进行特殊处理，直接将其替换为带有前缀的选择器。
     * --> app[data-qiankun="myApp"] body { margin: 0; }
     */
    if (selector === 'html' || selector === 'body' || selector === ':root') {
      return cssText.replace(rootSelectorRE, prefix);
    }

    /**
     * 处理带 html 的组合选择器
     * 如 html body、html > body 这样的组合选择器
     */
    if (rootCombinationRE.test(rule.selectorText)) {
      const siblingSelectorRE = /(html[^\w{]+)(\+|~)/gm;

      // 匹配以 html 开头的组合选择器
      // 因为 html + body 是 html 的非标准规则,不需要带 html
      if (!siblingSelectorRE.test(rule.selectorText)) {
        // 将 html 移除，保留子选择器 body 的样式
        cssText = cssText.replace(rootCombinationRE, '');
      }
    }


    /**
     * 处理普通选择器：对普通选择器加上前缀，确保这些样式只作用于特定的作用域。
     */
    cssText =
    // 匹配 CSS 规则的选择器部分，直到遇到 { 为止
    cssText.replace(/^[\s\S]+{/, (selectors) =>
      // 匹配选择器中的每个单独的选择器 会匹配选择器前的逗号或换行符，并捕获选择器本身
      selectors.replace(/(^|,\n?)([^,]+)/g, (item, p, s) => {
        // item 是当前匹配的选择器（如 div、body），p 是前面的逗号或换行符，s 是选择器的名称
        if (rootSelectorRE.test(item)) {
          // 如果当前选择器是根选择器，则使用 rootSelectorRE 替换为带有前缀的选择器
          return item.replace(rootSelectorRE, (m) => {
            // do not discard valid previous character, such as body,html or *:not(:root)
            const whitePrevChars = [',', '('];

            if (m && whitePrevChars.includes(m[0])) {
              return `${m[0]}${prefix}`;
            }

            // replace root selector with prefix
            return prefix;
          });
        }

        // 对于普通选择器（非根选择器），将前缀添加到选择器前面
        // id 和 class 选择器
        return `${p}${prefix} ${s.replace(/^ */, '')}`;
      }),
    );

    return cssText;
  }

  // handle case:
  // @media screen and (max-width: 300px) {}
  private ruleMedia(rule: CSSMediaRule, prefix: string) {
    const css = this.rewrite(arrayify(rule.cssRules), prefix);
    // 直接访问 rule.cssRules 时，它返回的是内部的规则，而 @media 本身的头部部分不会包含在 cssRules 中
    // rule.conditionText: 返回媒体查询条件，如 "screen and (max-width: 300px)"。
    // 如果 conditionText 不可用（兼容性考虑），则通过 cssText.split('{')[0] 获取媒体查询条件，即在 { 之前的部分。
    return `@media ${rule.conditionText || rule.media.mediaText} {${css}}`;
  }

  // handle case:
  // @supports (display: grid) {}
  private ruleSupport(rule: CSSSupportsRule, prefix: string) {
    const css = this.rewrite(arrayify(rule.cssRules), prefix);
    return `@supports ${rule.conditionText || rule.cssText.split('{')[0]} {${css}}`;
  }
}

let processor: ScopedCSS;

export const QiankunCSSRewriteAttr = 'data-qiankun';
export const process = (
  appWrapper: HTMLElement,
  stylesheetElement: HTMLStyleElement | HTMLLinkElement,
  appName: string,
): void => {
  // lazy singleton pattern
  if (!processor) {
    processor = new ScopedCSS();
  }

  if (stylesheetElement.tagName === 'LINK') {
    console.warn('Feature: sandbox.experimentalStyleIsolation is not support for link element yet.');
  }

  const mountDOM = appWrapper;
  if (!mountDOM) {
    return;
  }

  const tag = (mountDOM.tagName || '').toLowerCase();

  if (tag && stylesheetElement.tagName === 'STYLE') {
    // 标签名称 + [data-qiankun=应用名称]
    const prefix = `${tag}[${QiankunCSSRewriteAttr}="${appName}"]`;
    processor.process(stylesheetElement, prefix);
  }
};

