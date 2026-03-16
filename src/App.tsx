import { useEffect, useState } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
} from 'react-router-dom';
import { supabase } from './lib/supabase';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/admin/Dashboard';
import WorkOrderUpload from './pages/admin/WorkOrderUpload';
import Downloads from './pages/admin/Downloads';
import BOMManage from './pages/admin/BOMManage';
import UserManage from './pages/admin/UserManage';
import InventoryUpload from './pages/admin/InventoryUpload';
import ShipmentConfirm from './pages/offline/ShipmentConfirm';
import ReceiptCheck from './pages/playwith/ReceiptCheck';
import MarkingWork from './pages/playwith/MarkingWork';
import ShipmentOut from './pages/playwith/ShipmentOut';
import ActivityHistory from './pages/admin/ActivityHistory';
import InventoryManage from './pages/admin/InventoryManage';
import StockLedger from './pages/admin/StockLedger';
import type { UserRole, AppUser } from './types';

function AppContent() {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewAs, setViewAs] = useState<UserRole | null>(null);
  const navigate = useNavigate();

  const defaultPaths: Record<UserRole, string> = {
    admin: '/admin/dashboard',
    offline: '/offline/shipment',
    playwith: '/playwith/receipt',
  };

  /**
   * Supabase user_profile을 조회해 AppUser를 설정한다.
   * shouldNavigate=true 이면 역할별 기본 페이지로 이동한다.
   * (실제 로그인 시에만 true, 세션 복원·토큰 갱신 시에는 false)
   */
  const loadUserProfile = async (
    userId: string,
    email: string,
    shouldNavigate: boolean
  ) => {
    try {
      const { data: profile } = await supabase
        .from('user_profile')
        .select('*')
        .eq('id', userId)
        .single();

      const appUser: AppUser = profile
        ? {
            id: userId,
            email,
            role: profile.role as UserRole,
            name: profile.name,
          }
        : { id: userId, email, role: 'admin', name: email };

      setUser(appUser);

      if (shouldNavigate) {
        navigate(defaultPaths[appUser.role]);
      }
    } catch (err) {
      console.error('loadUserProfile error:', err);
      // 예상치 못한 에러 → 로딩만 해제 (로그인 화면으로 자연스럽게 유도)
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    /**
     * onAuthStateChange를 단일 진실 원천으로 사용.
     *
     * 이벤트별 처리:
     *   INITIAL_SESSION - 앱 시작 시 기존 세션 복원 (navigate 없음)
     *   SIGNED_IN       - 실제 로그인 성공 (역할별 기본 페이지로 navigate)
     *   TOKEN_REFRESHED - JWT 자동 갱신 (navigate 없음, user 유지)
     *   SIGNED_OUT      - 로그아웃 (로그인 페이지로 navigate)
     *
     * 안전망: GoTrue·loadUserProfile 등이 어떤 이유로든 hang하면
     * 20초 후 강제로 로딩 해제. (clearTimeout은 cleanup에서만 수행)
     * 정상 완료 시 setLoading(false)가 먼저 실행되므로 타이머 발화는 no-op.
     */
    const fallbackTimer = setTimeout(() => {
      console.warn('[Auth] 전체 초기화 타임아웃 (20s) — 강제 로딩 해제');
      setLoading(false);
    }, 20_000);

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'INITIAL_SESSION') {
        // 기존 세션 복원: 현재 페이지 유지 (navigate 없음)
        if (session) {
          await loadUserProfile(session.user.id, session.user.email || '', false);
        } else {
          setLoading(false);
        }
      } else if (event === 'SIGNED_IN') {
        // 실제 signInWithPassword 성공 → 역할 기본 페이지로 이동
        if (session) {
          await loadUserProfile(session.user.id, session.user.email || '', true);
        }
      } else if (event === 'SIGNED_OUT') {
        setUser(null);
        setLoading(false);
        navigate('/login');
      }
      // TOKEN_REFRESHED, USER_UPDATED: user 상태 그대로 유지, navigate 없음
    });

    return () => {
      clearTimeout(fallbackTimer);
      subscription.unsubscribe();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-gray-400">로딩 중...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const handleViewAsChange = (role: UserRole | null) => {
    setViewAs(role);
    if (role === 'offline') navigate('/offline/shipment');
    else if (role === 'playwith') navigate('/playwith/receipt');
    else navigate('/admin/dashboard');
  };

  return (
    <Layout
      role={user.role}
      userName={user.name}
      viewAs={viewAs}
      onViewAsChange={handleViewAsChange}
    >
      <Routes>
        {/* 관리자 */}
        <Route path="/admin/dashboard" element={<Dashboard />} />
        <Route path="/admin/workorder" element={<WorkOrderUpload />} />
        <Route path="/admin/downloads" element={<Downloads />} />
        <Route path="/admin/bom" element={<BOMManage />} />
        <Route path="/admin/inventory" element={<InventoryUpload />} />
        <Route path="/admin/stock" element={<InventoryManage />} />
        {/* currentUserId를 prop으로 전달 → UserManage 내 getSession() 중복 제거 */}
        <Route path="/admin/users" element={<UserManage currentUserId={user.id} />} />
        <Route path="/admin/history" element={<ActivityHistory />} />
        <Route path="/admin/stock-ledger" element={<StockLedger />} />

        {/* 오프라인 매장 */}
        <Route path="/offline/shipment" element={<ShipmentConfirm currentUser={user} />} />

        {/* 플레이위즈 */}
        <Route path="/playwith/receipt" element={<ReceiptCheck currentUser={user} />} />
        <Route path="/playwith/marking" element={<MarkingWork currentUser={user} />} />
        <Route path="/playwith/shipment" element={<ShipmentOut currentUser={user} />} />

        {/* 기본 리다이렉트 */}
        <Route
          path="*"
          element={
            <Navigate
              to={
                user.role === 'admin'
                  ? '/admin/dashboard'
                  : user.role === 'offline'
                  ? '/offline/shipment'
                  : '/playwith/receipt'
              }
              replace
            />
          }
        />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
