import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { UserRole } from '../types';
import {
  LayoutDashboard,
  Upload,
  Download,
  Database,
  PackageCheck,
  ClipboardList,
  Clock,
  Users,
  LogOut,
  Menu,
  Eye,
  ShieldCheck,
  Warehouse,
  Truck,
  Package,
  BookOpen,
  ShoppingCart,
  List,
  BarChart3,
  ChevronDown,
  Settings,
  FileText,
} from 'lucide-react';

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
  roles: UserRole[];
}

interface NavGroup {
  label: string;
  icon: React.ReactNode;
  roles: UserRole[];
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: '현황',
    icon: <BarChart3 size={16} />,
    roles: ['admin'],
    items: [
      { label: '대시보드', path: '/admin/dashboard', icon: <LayoutDashboard size={18} />, roles: ['admin'] },
      { label: '진행 현황', path: '/admin/progress', icon: <ClipboardList size={18} />, roles: ['admin'] },
      { label: '활동 이력', path: '/admin/history', icon: <Clock size={18} />, roles: ['admin'] },
    ],
  },
  {
    label: '주문·작업',
    icon: <FileText size={16} />,
    roles: ['admin'],
    items: [
      { label: '주문 관리', path: '/admin/orders', icon: <ShoppingCart size={18} />, roles: ['admin'] },
      { label: '작업지시서 업로드', path: '/admin/workorder', icon: <Upload size={18} />, roles: ['admin'] },
      { label: '양식 다운로드', path: '/admin/downloads', icon: <Download size={18} />, roles: ['admin'] },
      { label: '수기 마킹 요청', path: '/admin/marking-request', icon: <ClipboardList size={18} />, roles: ['admin'] },
    ],
  },
  {
    label: '재고',
    icon: <Package size={16} />,
    roles: ['admin'],
    items: [
      { label: '재고 관리', path: '/admin/stock', icon: <Package size={18} />, roles: ['admin'] },
      { label: '재고 수불부', path: '/admin/stock-ledger', icon: <BookOpen size={18} />, roles: ['admin'] },
      { label: '입/출고 현황', path: '/admin/tx-history', icon: <BarChart3 size={18} />, roles: ['admin'] },
      { label: '매장 입/출고 등록', path: '/admin/sales', icon: <ShoppingCart size={18} />, roles: ['admin'] },
    ],
  },
  {
    label: '마스터',
    icon: <Settings size={16} />,
    roles: ['admin'],
    items: [
      { label: '품목 마스터', path: '/admin/sku-master', icon: <List size={18} />, roles: ['admin'] },
      { label: 'BOM 관리', path: '/admin/bom', icon: <Database size={18} />, roles: ['admin'] },
      { label: '재고 업로드', path: '/admin/inventory', icon: <Warehouse size={18} />, roles: ['admin'] },
      { label: '계정 관리', path: '/admin/users', icon: <Users size={18} />, roles: ['admin'] },
    ],
  },
  {
    label: '오프라인 매장',
    icon: <PackageCheck size={16} />,
    roles: ['offline'],
    items: [
      { label: '발송 확인', path: '/offline/shipment', icon: <PackageCheck size={18} />, roles: ['offline'] },
    ],
  },
  {
    label: '플레이위즈',
    icon: <ClipboardList size={16} />,
    roles: ['playwith'],
    items: [
      { label: '입고 확인', path: '/playwith/receipt', icon: <PackageCheck size={18} />, roles: ['playwith'] },
      { label: '마킹 작업', path: '/playwith/marking', icon: <ClipboardList size={18} />, roles: ['playwith'] },
      { label: '출고 확인', path: '/playwith/shipment', icon: <Truck size={18} />, roles: ['playwith'] },
      { label: '매장 이관', path: '/playwith/transfer', icon: <Package size={18} />, roles: ['playwith'] },
    ],
  },
];

interface LayoutProps {
  children: React.ReactNode;
  role: UserRole;
  userName: string;
  viewAs?: UserRole | null;
  onViewAsChange?: (role: UserRole | null) => void;
}

export default function Layout({ children, role, userName, viewAs, onViewAsChange }: LayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    // 현재 경로가 속한 그룹을 기본 펼침
    const initial = new Set<string>();
    for (const g of navGroups) {
      if (g.items.some((i) => location.pathname === i.path)) initial.add(g.label);
    }
    return initial;
  });

  const toggleGroup = (label: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const effectiveRole = (role === 'admin' && viewAs) ? viewAs : role;

  const roleLabel = {
    admin: '관리자',
    offline: '오프라인 매장',
    playwith: '플레이위즈',
  }[effectiveRole];

  const filteredGroups = navGroups.filter((g) => g.roles.includes(effectiveRole));

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex bg-gray-100">
      {/* 모바일 오버레이 */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* 사이드바 */}
      <aside
        className={`fixed inset-y-0 left-0 w-64 bg-gray-900 text-white flex flex-col z-30 transform transition-transform duration-200 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 lg:static lg:inset-0`}
      >
        <div className="p-5 border-b border-gray-700">
          <h1 className="text-lg font-bold text-white">마킹 재고 관리</h1>
          <p className="text-xs text-gray-400 mt-1">{roleLabel} · {userName}</p>
        </div>

        {/* 관리자 전용: 화면 전환 스위처 */}
        {role === 'admin' && onViewAsChange && (
          <div className="px-4 pt-4 pb-2 border-b border-gray-700">
            <p className="text-xs text-gray-500 mb-2 flex items-center gap-1">
              <Eye size={12} />
              화면 미리보기
            </p>
            <div className="flex flex-col gap-1">
              <button
                onClick={() => { onViewAsChange(null); setSidebarOpen(false); }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors text-left ${
                  !viewAs
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                }`}
              >
                <ShieldCheck size={14} />
                관리자 화면
              </button>
              <button
                onClick={() => { onViewAsChange('offline'); setSidebarOpen(false); }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors text-left ${
                  viewAs === 'offline'
                    ? 'bg-orange-500 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                }`}
              >
                <PackageCheck size={14} />
                오프라인 매장 화면
              </button>
              <button
                onClick={() => { onViewAsChange('playwith'); setSidebarOpen(false); }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors text-left ${
                  viewAs === 'playwith'
                    ? 'bg-purple-500 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                }`}
              >
                <ClipboardList size={14} />
                플레이위즈 화면
              </button>
            </div>
          </div>
        )}

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {filteredGroups.map((group) => {
            const isExpanded = expandedGroups.has(group.label);
            const hasActive = group.items.some((i) => location.pathname === i.path);
            return (
              <div key={group.label}>
                <button
                  onClick={() => toggleGroup(group.label)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                    hasActive ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {group.icon}
                  <span className="flex-1 text-left">{group.label}</span>
                  <ChevronDown size={14} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                </button>
                {isExpanded && (
                  <div className="ml-2 mt-0.5 space-y-0.5">
                    {group.items.map((item) => (
                      <Link
                        key={item.path}
                        to={item.path}
                        onClick={() => setSidebarOpen(false)}
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors
                          ${location.pathname === item.path
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                          }`}
                      >
                        {item.icon}
                        {item.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="p-4 border-t border-gray-700">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2.5 w-full rounded-lg text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors"
          >
            <LogOut size={18} />
            로그아웃
          </button>
        </div>
      </aside>

      {/* 메인 영역 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 모바일 헤더 */}
        <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 rounded-md hover:bg-gray-100"
          >
            <Menu size={20} />
          </button>
          <span className="font-semibold text-gray-900">마킹 재고 관리</span>
        </header>

        {/* 뷰모드 배너 */}
        {role === 'admin' && viewAs && (
          <div className={`px-4 py-2 text-xs font-medium flex items-center gap-2 ${
            viewAs === 'offline'
              ? 'bg-orange-100 text-orange-800 border-b border-orange-200'
              : 'bg-purple-100 text-purple-800 border-b border-purple-200'
          }`}>
            <Eye size={13} />
            관리자 미리보기 모드 —&nbsp;
            <span className="font-semibold">
              {viewAs === 'offline' ? '오프라인 매장' : '플레이위즈'} 화면
            </span>
            을 보고 있습니다.
            <button
              onClick={() => onViewAsChange && onViewAsChange(null)}
              className="ml-auto underline opacity-70 hover:opacity-100"
            >
              관리자 화면으로 돌아가기
            </button>
          </div>
        )}

        <main className="flex-1 p-4 lg:p-6 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
