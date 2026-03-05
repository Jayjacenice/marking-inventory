import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, ChevronDown, ChevronUp, X } from 'lucide-react';

// ── 타입 (4개 화면에서 공유) ────────────────

export interface ComparisonRow {
  skuId: string;
  skuName: string;
  expected: number;
  uploaded: number;
  diff: number; // uploaded - expected
}

interface ComparisonPanelProps {
  rows: ComparisonRow[];
  unmatched?: string[];
  onClose: () => void;
}

// ── 컴포넌트 ────────────────────────────────

export default function ComparisonPanel({ rows, unmatched, onClose }: ComparisonPanelProps) {
  // 차이/일치 분리 + |diff| 큰 순 정렬
  const diffRows = rows
    .filter((r) => r.diff !== 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const matchRows = rows.filter((r) => r.diff === 0);

  // 일치 섹션 접기 (차이 없으면 기본 펼침)
  const [matchExpanded, setMatchExpanded] = useState(diffRows.length === 0);

  useEffect(() => {
    setMatchExpanded(diffRows.length === 0);
  }, [rows]);

  // ── 행 렌더링 ──

  const renderRow = (row: ComparisonRow) => (
    <div key={row.skuId} className="grid grid-cols-4 px-4 py-2.5 text-xs items-center">
      <span className="text-gray-800 truncate pr-2">{row.skuName}</span>
      <span className="text-right text-gray-500">{row.expected}</span>
      <span className="text-right text-gray-800 font-medium">{row.uploaded}</span>
      <span
        className={`text-right font-medium ${
          row.diff > 0
            ? 'text-orange-600'
            : row.diff < 0
            ? 'text-red-600'
            : 'text-green-600'
        }`}
      >
        {row.diff > 0 ? `+${row.diff}` : row.diff === 0 ? '0' : row.diff}
      </span>
    </div>
  );

  // ── 테이블 헤더 ──

  const tableHeader = (
    <div className="grid grid-cols-4 px-4 py-2 bg-gray-50 text-xs text-gray-500 font-medium border-b border-gray-100">
      <span>SKU명</span>
      <span className="text-right">예정</span>
      <span className="text-right">업로드</span>
      <span className="text-right">차이</span>
    </div>
  );

  return (
    <div className="bg-white rounded-xl shadow-sm border border-blue-100 overflow-hidden">
      {/* 헤더 */}
      <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-gray-900">업로드 비교 결과</p>
            {diffRows.length > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-red-100 text-red-700 rounded-full">
                차이 {diffRows.length}
              </span>
            )}
            {matchRows.length > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-green-100 text-green-700 rounded-full">
                일치 {matchRows.length}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-0.5">{rows.length}개 품목 수량 적용됨</p>
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 transition-colors p-1"
        >
          <X size={15} />
        </button>
      </div>

      {/* 차이 섹션 */}
      {diffRows.length > 0 && (
        <div>
          <div className="px-4 py-2.5 bg-red-50 border-b border-red-200 flex items-center gap-2">
            <AlertTriangle size={14} className="text-red-600" />
            <span className="text-xs font-medium text-red-800">
              차이 발생 ({diffRows.length}건)
            </span>
          </div>
          {tableHeader}
          <div className="divide-y divide-gray-50 max-h-40 overflow-y-auto">
            {diffRows.map(renderRow)}
          </div>
        </div>
      )}

      {/* 일치 섹션 */}
      {matchRows.length > 0 && (
        <div>
          <button
            onClick={() => setMatchExpanded((prev) => !prev)}
            className="w-full px-4 py-2.5 bg-green-50 border-y border-green-200 flex items-center justify-between hover:bg-green-100 transition-colors"
          >
            <div className="flex items-center gap-2">
              <CheckCircle size={14} className="text-green-600" />
              <span className="text-xs font-medium text-green-800">
                수량 일치 ({matchRows.length}건)
              </span>
            </div>
            {matchExpanded ? (
              <ChevronUp size={14} className="text-green-600" />
            ) : (
              <ChevronDown size={14} className="text-green-600" />
            )}
          </button>
          {matchExpanded && (
            <>
              {diffRows.length === 0 && tableHeader}
              <div className="divide-y divide-gray-50 max-h-32 overflow-y-auto">
                {matchRows.map(renderRow)}
              </div>
            </>
          )}
        </div>
      )}

      {/* 미매칭 경고 */}
      {unmatched && unmatched.length > 0 && (
        <div className="px-4 py-2.5 border-t border-gray-100 bg-yellow-50">
          <p className="text-xs text-yellow-800">
            미매칭 {unmatched.length}개:{' '}
            {unmatched.slice(0, 3).join(', ')}
            {unmatched.length > 3 && ` 외 ${unmatched.length - 3}개`}
          </p>
        </div>
      )}
    </div>
  );
}
