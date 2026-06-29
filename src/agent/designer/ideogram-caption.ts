import type { Sprite, SpriteCategory, SpritesheetMetadata } from '../types';
import { GRID_CONFIG } from '../config';

interface IdeogramStyleDescription {
  aesthetics: string;
  lighting: string;
  medium: 'illustration';
  art_style: string;
  color_palette?: string[];
}

interface IdeogramElement {
  type: 'obj';
  bbox: [number, number, number, number];
  desc: string;
}

export interface IdeogramJsonPrompt {
  high_level_description: string;
  style_description: IdeogramStyleDescription;
  compositional_deconstruction: {
    background: string;
    elements: IdeogramElement[];
  };
}

function bboxForSprite(sprite: Sprite, metadata: SpritesheetMetadata): IdeogramElement['bbox'] {
  const yMin = Math.round((sprite.row / metadata.rows) * 1000);
  const xMin = Math.round((sprite.col / metadata.columns) * 1000);
  const yMax = Math.round(((sprite.row + sprite.h) / metadata.rows) * 1000);
  const xMax = Math.round(((sprite.col + sprite.w) / metadata.columns) * 1000);
  return [
    Math.max(0, Math.min(1000, yMin)),
    Math.max(0, Math.min(1000, xMin)),
    Math.max(0, Math.min(1000, yMax)),
    Math.max(0, Math.min(1000, xMax)),
  ];
}

function perspectiveForCategory(category: SpriteCategory): string {
  switch (category) {
    case 'ground':
      return 'pure overhead tile';
    case 'building':
      return '3/4 JRPG building sprite';
    case 'prop':
      return '3/4 JRPG prop sprite';
    case 'wall':
      return '3/4 wall sprite';
    case 'marker':
      return 'floating game marker';
  }
}

function extractPalette(text?: string): string[] | undefined {
  const colors = [...new Set(text?.match(/#[0-9A-Fa-f]{6}\b/g)?.map((c) => c.toUpperCase()))];
  return colors.length > 0 ? colors.slice(0, 16) : undefined;
}

export function generateIdeogramCaption(metadata: SpritesheetMetadata): IdeogramJsonPrompt {
  const palette = extractPalette(metadata.sceneDescription ?? metadata.theme);
  const styleDescription: IdeogramStyleDescription = {
    aesthetics: `${metadata.theme} JRPG spritesheet, crisp readable pixel art, consistent silhouettes`,
    lighting: 'top-left key light with soft shadows falling toward the bottom-right',
    medium: 'illustration',
    art_style: 'clean top-down game asset spritesheet, hard pixel edges, no smoothing',
    ...(palette ? { color_palette: palette } : {}),
  };

  return {
    high_level_description:
      `A ${metadata.columns}x${metadata.rows} JRPG pixel-art spritesheet for a ${metadata.theme} world, ` +
      `with every ${GRID_CONFIG.tileSize}px tile isolated on a pure white background for transparency masking.`,
    style_description: styleDescription,
    compositional_deconstruction: {
      background:
        'A pure white #FFFFFF spritesheet canvas divided into an invisible uniform grid. Each asset stays fully inside its assigned grid cell with clear separation.',
      elements: metadata.sprites.map((sprite) => ({
        type: 'obj',
        bbox: bboxForSprite(sprite, metadata),
        desc:
          `${sprite.id}: ${perspectiveForCategory(sprite.category)}. ${sprite.description}. ` +
          'Keep the asset centered inside its assigned box with clean transparent-mask-ready edges.',
      })),
    },
  };
}
