import { data as f1 } from '../../../data/spritesheets/f1';
import { data as f2 } from '../../../data/spritesheets/f2';
import { data as f3 } from '../../../data/spritesheets/f3';
import { data as f4 } from '../../../data/spritesheets/f4';
import { data as f5 } from '../../../data/spritesheets/f5';
import { data as f6 } from '../../../data/spritesheets/f6';
import { data as f7 } from '../../../data/spritesheets/f7';
import { data as f8 } from '../../../data/spritesheets/f8';

/**
 * Sprite roster. Same sheets as upstream (`data/spritesheets/*`), but the
 * texture URLs are relative so the app works from any base path and there is no
 * `/ai-town` deployment assumption.
 */
export const characters = [
  { name: 'f1', textureUrl: 'assets/32x32folk.png', spritesheetData: f1, speed: 0.1 },
  { name: 'f2', textureUrl: 'assets/32x32folk.png', spritesheetData: f2, speed: 0.1 },
  { name: 'f3', textureUrl: 'assets/32x32folk.png', spritesheetData: f3, speed: 0.1 },
  { name: 'f4', textureUrl: 'assets/32x32folk.png', spritesheetData: f4, speed: 0.1 },
  { name: 'f5', textureUrl: 'assets/32x32folk.png', spritesheetData: f5, speed: 0.1 },
  { name: 'f6', textureUrl: 'assets/32x32folk.png', spritesheetData: f6, speed: 0.1 },
  { name: 'f7', textureUrl: 'assets/32x32folk.png', spritesheetData: f7, speed: 0.1 },
  { name: 'f8', textureUrl: 'assets/32x32folk.png', spritesheetData: f8, speed: 0.1 },
];

export type CharacterSprite = (typeof characters)[number];

export function findCharacter(name: string): CharacterSprite | undefined {
  return characters.find((c) => c.name === name);
}

export const characterNames = characters.map((c) => c.name);
