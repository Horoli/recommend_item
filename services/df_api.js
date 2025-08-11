// services/df_api.js

require("dotenv").config();
const axios = require("axios");

const DP_API_KEY = process.env.DP_API_KEY; // 필요시 사용
const BASE = "https://api.neople.co.kr/df";

// 공용 axios 인스턴스 (기능 동일, 기본 timeout만 추가)
const http = axios.create({
  baseURL: BASE,
  timeout: 10_000,
});

class DfApi {
  /**
   * 캐릭터 찾기
   * 반환: { characterId, raw } | null
   */
  static async findCharacter(server, name) {
    const url = `/servers/${encodeURIComponent(
      server
    )}/characters?characterName=${encodeURIComponent(
      name
    )}&apikey=${DP_API_KEY}`;

    const res = await http.get(url).catch(() => null);
    if (!res || !res.data) return null;

    // API 응답이 { rows: [...] } 형태일 수도 있음
    const data = res.data.rows || res.data;
    if (!data || data.length === 0) return null;

    const ch = Array.isArray(data) ? data[0] : data;
    return {
      characterId: ch.characterId || ch.character_id,
      raw: ch,
    };
  }

  /**
   * 장비 조회
   * 반환: API 원본(res.data)
   */
  static async getEquipment(server, characterId) {
    const url = `/servers/${encodeURIComponent(
      server
    )}/characters/${encodeURIComponent(
      characterId
    )}/equip/equipment?apikey=${DP_API_KEY}`;

    const res = await http.get(url); // 에러는 상위로 throw
    return res.data;
  }

  /**
   * 경매장 최저가(업그레이드 구분 없이 전체 중 최저가 1건)
   * 반환: { lowestPrice, raw } | null
   */
  static async getAuctionLowestPrice(itemId) {
    const url = `/auction?itemId=${encodeURIComponent(
      itemId
    )}&limit=1&sort=unitPrice:asc&apikey=${DP_API_KEY}`;

    const res = await http.get(url).catch(() => null);
    if (!res || !res.data) return null;

    const item = res.data.rows && res.data.rows[0];
    if (!item) return null;

    return {
      lowestPrice: item.unitPrice || item.price || item.currentPrice || null,
      //   raw: item,
    };
  }
}

module.exports = DfApi;
