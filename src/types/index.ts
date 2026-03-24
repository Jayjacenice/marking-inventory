export type SkuType = '완제품' | '유니폼단품' | '마킹단품';

export interface Sku {
  sku_id: string;
  sku_name: string;
  barcode: string | null;
  type: SkuType;
  berriz_id?: string | null;
}

export interface BomItem {
  id: string;
  finished_sku_id: string;
  component_sku_id: string;
  quantity: number;
  component?: Sku;
}

export interface Warehouse {
  id: string;
  name: string;
  external_id: string; // BERRIZ 창고 ID
}

export interface Inventory {
  warehouse_id: string;
  sku_id: string;
  quantity: number;
  sku?: Sku;
  warehouse?: Warehouse;
}

export type WorkOrderStatus =
  | '업로드됨'
  | '이관준비'
  | '이관중'
  | '취소요청'
  | '수정요청'
  | '입고확인완료'
  | '마킹중'
  | '마킹완료'
  | '출고완료';

export interface WorkOrder {
  id: string;
  uploaded_at: string;
  download_date: string;
  status: WorkOrderStatus;
  lines?: WorkOrderLine[];
}

export interface WorkOrderLine {
  id: string;
  work_order_id: string;
  finished_sku_id: string;
  ordered_qty: number;
  sent_qty: number;
  received_qty: number;
  marked_qty: number;
  needs_marking: boolean;
  finished_sku?: Sku;
  bom_components?: BomItem[];
}

export interface DailyMarking {
  id: string;
  date: string;
  work_order_line_id: string;
  completed_qty: number;
  sent_to_cj_qty: number;
  line?: WorkOrderLine;
}

export type UserRole = 'admin' | 'offline' | 'playwith';

export interface AppUser {
  id: string;
  email: string;
  role: UserRole;
  name: string;
}

export type TxType = '입고' | '출고' | '반품' | '재고조정' | '마킹출고' | '마킹입고' | '판매' | '기초재고';
export type TxSource = 'cj_excel' | 'system' | 'manual' | 'pos_excel' | 'initial_stock' | 'offline_manual' | 'online_order';

export type OnlineOrderStatus = '신규' | '발송대기' | '이관중' | '마킹중' | '출고완료' | '재고부족' | '하자재발송' | '취소';

export interface OnlineOrder {
  id: string;
  order_number: string;
  delivery_number: string | null;
  order_date: string | null;
  sku_id: string;
  sku_name: string | null;
  option_text: string | null;
  quantity: number;
  needs_marking: boolean;
  status: OnlineOrderStatus;
  created_at: string;
}

export interface InventoryTransaction {
  id: string;
  warehouse_id: string;
  sku_id: string;
  tx_type: TxType;
  quantity: number;
  source: TxSource;
  memo: string | null;
  tx_date: string;
  created_at: string;
  warehouse?: Warehouse;
  sku?: Sku;
}

export type ActionType = 'shipment_confirm' | 'receipt_check' | 'marking_work' | 'shipment_out' | 'shipment_cancel_request' | 'shipment_cancel_approved' | 'shipment_modify_request' | 'shipment_modify_approved' | 'delete_shipment' | 'delete_receipt' | 'delete_marking' | 'delete_shipment_out' | 'rollback_shipment' | 'rollback_receipt' | 'rollback_marking' | 'rollback_shipment_out';

export interface ActivityLog {
  id: string;
  user_id: string;
  action_type: ActionType;
  work_order_id: string | null;
  action_date: string;
  summary: {
    items: { skuId: string; skuName: string; [key: string]: any }[];
    totalQty: number;
    workOrderDate?: string;
  };
  created_at: string;
  user_profile?: { name: string; role: string };
}
