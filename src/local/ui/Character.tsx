import { BaseTexture, ISpritesheetData, Spritesheet, SCALE_MODES } from 'pixi.js';
import { useState, useEffect, useRef } from 'react';
import { AnimatedSprite, Container, Graphics, Text } from '@pixi/react';
import * as PIXI from 'pixi.js';
import { resolveAssetUrl } from '../assets';

/**
 * A walking, thinking, talking sprite. Essentially upstream's
 * `src/components/Character.tsx` with asset-URL resolution so it works from any
 * base path (and with uploaded tilesets).
 */
export const Character = ({
  textureUrl,
  spritesheetData,
  x,
  y,
  orientation,
  isMoving = false,
  isThinking = false,
  isSpeaking = false,
  emoji = '',
  isViewer = false,
  speed = 0.1,
  onClick,
  scale = 1,
}: {
  textureUrl: string;
  spritesheetData: ISpritesheetData;
  x: number;
  y: number;
  orientation: number;
  isMoving?: boolean;
  isThinking?: boolean;
  isSpeaking?: boolean;
  emoji?: string;
  isViewer?: boolean;
  speed?: number;
  onClick?: () => void;
  scale?: number;
}) => {
  const [spriteSheet, setSpriteSheet] = useState<Spritesheet>();
  useEffect(() => {
    let cancelled = false;
    const parseSheet = async () => {
      const resolved = resolveAssetUrl(textureUrl);
      if (!resolved) return;
      const sheet = new Spritesheet(BaseTexture.from(resolved, { scaleMode: SCALE_MODES.NEAREST }), spritesheetData);
      await sheet.parse();
      if (!cancelled) setSpriteSheet(sheet);
    };
    void parseSheet();
    return () => {
      cancelled = true;
    };
  }, [textureUrl]);

  const roundedOrientation = Math.floor((((orientation % 360) + 360) % 360) / 90);
  const direction = ['right', 'down', 'left', 'up'][roundedOrientation];

  const ref = useRef<PIXI.AnimatedSprite | null>(null);
  useEffect(() => {
    if (isMoving) ref.current?.play();
  }, [direction, isMoving]);

  if (!spriteSheet) return null;
  const frames = spriteSheet.animations[direction] ?? spriteSheet.animations['down'];
  if (!frames?.length) return null;

  return (
    <Container x={x} y={y} interactive={!!onClick} pointerdown={onClick} cursor={onClick ? 'pointer' : undefined}>
      {isThinking && (
        <Text x={-20} y={-10} scale={{ x: -0.8, y: 0.8 }} text={'💭'} anchor={{ x: 0.5, y: 0.5 }} />
      )}
      {isSpeaking && (
        <Text x={18} y={-10} scale={0.8} text={'💬'} anchor={{ x: 0.5, y: 0.5 }} />
      )}
      {isViewer && <ViewerIndicator />}
      <AnimatedSprite
        ref={ref}
        isPlaying={isMoving}
        textures={frames}
        animationSpeed={speed}
        anchor={{ x: 0.5, y: 0.5 }}
        scale={{ x: scale, y: scale }}
      />
      {emoji && (
        <Text x={0} y={-24} scale={{ x: -0.8, y: 0.8 }} text={emoji} anchor={{ x: 0.5, y: 0.5 }} />
      )}
    </Container>
  );
};

function ViewerIndicator() {
  return (
    <Graphics
      draw={(g: PIXI.Graphics) => {
        g.clear();
        g.beginFill(0xffff0b, 0.5);
        g.drawRoundedRect(-10, 10, 20, 10, 100);
        g.endFill();
      }}
    />
  );
}

/** Floating nameplate so you can tell who is who at a glance. */
export function Nameplate({
  x,
  y,
  text,
  highlight,
}: {
  x: number;
  y: number;
  text: string;
  highlight?: boolean;
}) {
  return (
    <Container x={x} y={y}>
      <Text
        text={text}
        style={
          new PIXI.TextStyle({
            fontFamily: 'monospace',
            fontSize: 10,
            fill: highlight ? 0xffe27a : 0xffffff,
            stroke: '#181425',
            strokeThickness: 3,
          })
        }
        anchor={{ x: 0.5, y: 0.5 }}
      />
    </Container>
  );
}
