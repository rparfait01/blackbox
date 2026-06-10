import type { KeywordLibrary } from './types';

/**
 * Japanese keyword library. Standard Japanese plus a few common forms.
 *
 * TODO(v1): Okinawan (Uchinaaguchi) dialect variants. Okinawa is the launch
 * market; some speakers use dialect under stress. Verified dialect terms for
 * "stop" / "help" / "it hurts" should be added here once confirmed with native
 * speakers rather than guessed.
 */
export const ja: KeywordLibrary = {
  language: 'ja',
  categories: {
    weapon: {
      weight: 5,
      words: ['銃', 'ナイフ', '刃物', '武器', '拳銃', 'ピストル', '刺す'],
      phrases: ['銃を持っている', 'ナイフを持っている', '刃物を持って'],
    },
    violence: {
      weight: 4,
      words: ['殴る', '殴っ', '殺す', '殺して', '蹴る', '叩く', '首を絞め', '暴力', '締める'],
      phrases: ['殺してやる', '殴られた', '叩かれた'],
    },
    restraint: {
      weight: 3,
      words: ['やめて', 'やめろ', '離して', '離せ', '放して', '触らないで', '来ないで', '近寄らないで'],
      phrases: ['やめてください', '触らないで', '来ないで', '放して', 'あっち行って'],
    },
    compliance: {
      weight: 2,
      words: [],
      phrases: ['なんでもします', '何でもします', '言う通りにします', '言うことを聞きます', '黙ってます', 'だまってる'],
    },
    fear: {
      weight: 3,
      words: ['助けて', 'たすけて', '怖い', 'こわい'],
      phrases: ['助けてください', '誰か助けて', '警察を呼んで', '怖いです', '殺さないで', '来ないでください'],
    },
    pain: {
      weight: 3,
      words: ['痛い', 'いたい'],
      phrases: ['痛いです', '痛い痛い', '腕が痛い', '離して痛い'],
    },
    medical: {
      weight: 4,
      words: ['血', '出血', '倒れた', '気を失'],
      phrases: ['息ができない', '血が出てる', '死にそう', '呼吸ができない', '意識がない'],
    },
    disorientation: {
      weight: 2,
      words: ['めまい', '混乱'],
      phrases: ['ここはどこ', '何があった', '目が見えない', '何を飲ませた', '頭が回らない'],
    },
    bargaining: {
      weight: 2,
      words: ['お願い', 'おねがい', '許して'],
      phrases: ['お願いします', '話し合おう', 'お金をあげる', '許してください'],
    },
    'profanity-distress': {
      weight: 2,
      words: ['くそ', 'ちくしょう', 'てめえ'],
      phrases: ['ふざけるな'],
    },
  },
};
