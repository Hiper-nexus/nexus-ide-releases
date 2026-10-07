import { createElement, forwardRef, useEffect, type ReactNode } from 'react'

// The slice of react-native that LegendList's native build touches, as host strings
// react-test-renderer can render. Use it as the whole `vi.mock('react-native')` factory
// (spread extra primitives the component under test needs on top).

type HostProps = { children?: ReactNode } & Record<string, unknown>

class AnimatedValue {
  private value: number
  constructor(value: number) {
    this.value = value
  }
  setValue(value: number): void {
    this.value = value
  }
  addListener(): string {
    return 'listener'
  }
  removeListener(): void {}
  removeAllListeners(): void {}
  stopAnimation(): void {}
  interpolate(): AnimatedValue {
    return this
  }
  __getValue(): number {
    return this.value
  }
}

function host(name: string) {
  const component = forwardRef<unknown, HostProps>(function MockHost(props, ref) {
    return createElement(name, { ...props, ref }, props.children as ReactNode)
  })
  component.displayName = name
  return component
}

export type LegendListReactNativeMockOptions = {
  windowHeight?: number
  /** Called once per mount of the list's ScrollView — a remount shows up as a second call. */
  onScrollViewMount?: () => void
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) {
    return {}
  }
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle))
  }
  return typeof style === 'object' ? { ...(style as Record<string, unknown>) } : {}
}

/** LegendList schedules layout work on animation frames, which the node test env lacks. */
export function installAnimationFrameShim(): void {
  const scope = globalThis as {
    requestAnimationFrame?: (callback: (time: number) => void) => unknown
    cancelAnimationFrame?: (handle: unknown) => void
  }
  scope.requestAnimationFrame ??= (callback) => setTimeout(() => callback(Date.now()), 0)
  scope.cancelAnimationFrame ??= (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export function createLegendListReactNativeMock(options: LegendListReactNativeMockOptions = {}) {
  installAnimationFrameShim()
  const windowHeight = options.windowHeight ?? 800
  const ScrollView = forwardRef<unknown, HostProps>(function MockScrollView(props, ref) {
    useEffect(() => {
      options.onScrollViewMount?.()
    }, [])
    return createElement('ScrollView', { ...props, ref }, props.children as ReactNode)
  })
  return {
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      View: host('AnimatedView'),
      ScrollView,
      Value: AnimatedValue,
      event: () => () => {}
    },
    Dimensions: { get: () => ({ width: 390, height: windowHeight, scale: 3, fontScale: 1 }) },
    I18nManager: { isRTL: false },
    PixelRatio: { get: () => 3, roundToNearestPixel: (value: number) => value },
    Platform: {
      OS: 'ios',
      select: <T>(choices: { ios?: T; default?: T }) => choices.ios ?? choices.default
    },
    Pressable: 'Pressable',
    RefreshControl: 'RefreshControl',
    StyleSheet: {
      create: <T>(styles: T) => styles,
      flatten: flattenStyle,
      hairlineWidth: 1,
      absoluteFill: {},
      absoluteFillObject: {}
    },
    Text: 'Text',
    View: 'View',
    unstable_batchedUpdates: (callback: () => void) => callback()
  }
}
