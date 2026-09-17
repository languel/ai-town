import { PixiComponent } from '@pixi/react';
import { Viewport } from 'pixi-viewport';
import { Application } from 'pixi.js';
import type { MutableRefObject, ReactNode } from 'react';

export type ViewportProps = {
  app: Application;
  viewportRef?: MutableRefObject<Viewport | undefined>;
  screenWidth: number;
  screenHeight: number;
  worldWidth: number;
  worldHeight: number;
  zoomMin?: number;
  zoomMax?: number;
  children?: ReactNode;
};

/** Drag/zoom viewport (same component the hosted client used, minus Convex). */
export default PixiComponent('Viewport', {
  create(props: ViewportProps) {
    const { app, children: _children, viewportRef, zoomMin, zoomMax, ...viewportProps } = props;
    const viewport = new Viewport({
      events: app.renderer.events,
      passiveWheel: false,
      ...viewportProps,
    } as any);
    if (viewportRef) viewportRef.current = viewport;
    viewport
      .drag()
      .pinch({})
      .wheel()
      .decelerate()
      .clamp({ direction: 'all', underflow: 'center' })
      .setZoom(-10)
      .clampZoom({
        minScale: zoomMin ?? (1.04 * props.screenWidth) / (props.worldWidth / 2),
        maxScale: zoomMax ?? 3.5,
      });
    return viewport;
  },
  applyProps(viewport: any, oldProps: any, newProps: any) {
    for (const key of Object.keys(newProps)) {
      if (
        key !== 'app' &&
        key !== 'viewportRef' &&
        key !== 'children' &&
        oldProps[key] !== newProps[key]
      ) {
        viewport[key] = newProps[key];
      }
    }
  },
});
